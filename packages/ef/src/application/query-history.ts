/**
 * History lookup execution (10-query-and-trace.md "History Lookup").
 *
 * Walks the captured integration ref's complete first-parent history
 * (oldest to newest) and, for each commit, decodes exactly the two things
 * needed at that historical point in time -- the target Artifact's own
 * envelope and every CHG file's envelope -- by reusing the same
 * `splitFrontmatter` / `parseFrontmatterDocument` / `decodeEnvelope`
 * pipeline `./snapshot.ts` uses for the *current* snapshot, applied here to
 * historical Git blobs instead of working-tree files.
 *
 * Deliberately does not use `GitRepository#diffTrees`: the Artifact aggregate
 * for one ID is a small, explicitly known candidate path set (the canonical
 * file, its currently-or-previously declared local Resource locations, and,
 * for PROJECT, the two control files), so each commit's relevant changes are
 * found by comparing blob OIDs at exactly those candidate paths against the
 * previous commit, rather than diffing (and discarding most of) the
 * project's complete tree.
 *
 * Known scope limitation: this reads a full recursive tree listing
 * (`git ls-tree -r`) for every commit in the walked history, not only commits
 * that touch the target aggregate. Acceptable for EF Core v1's correctness
 * requirements; a real performance-sensitive implementation would want a
 * cheaper per-commit existence/oid probe instead.
 */

import type { ArtifactType, Envelope, Status } from '../domain/model'
import type { GitRepository, GitTreeEntry } from '../git/repository'
import type { HistoryCommitData, HistoryEffectData } from './query-types'
import type { SnapshotArtifactRecord } from './snapshot-validation'
import { decodeEnvelope } from '../domain/envelope'
import { compareBytewise } from '../domain/model'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { buildArtifactSummary, canonicalArtifactPath } from './query-projection'

const PROJECT_CONTROL_PATHS = ['.engineering/ef.yaml', '.engineering/.gitignore'] as const
const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

function isLocalResourceLocation(location: string): boolean {
	return !location.startsWith('http://') && !location.startsWith('https://')
}

export interface HistoryOutcome {
	effects: HistoryEffectData[]
	commits: HistoryCommitData[]
}

/** `undefined` means the required first-parent history could not be completely materialized (`EF-QRY-010`: shallow, missing, or otherwise inaccessible). */
export async function computeHistory(
	git: GitRepository,
	integrationRefOid: string,
	targetId: string,
	targetType: ArtifactType,
	byId: ReadonlyMap<string, SnapshotArtifactRecord>,
): Promise<HistoryOutcome | undefined> {
	const historyResult = await git.listFirstParentHistory(integrationRefOid)
	if (historyResult.kind !== 'complete')
		return undefined

	const oidsOldestFirst = [...historyResult.oids].reverse()
	const canonicalPath = canonicalArtifactPath(targetType, targetId)
	const isProject = targetType === 'project'

	const treeCache = new Map<string, Map<string, GitTreeEntry> | undefined>()
	async function treeMapAt(oid: string): Promise<Map<string, GitTreeEntry> | undefined> {
		if (treeCache.has(oid))
			return treeCache.get(oid)
		const result = await git.readTree(oid)
		const map = result.kind === 'resolved' ? new Map(result.entries.map(entry => [entry.path, entry] as const)) : undefined
		treeCache.set(oid, map)
		return map
	}

	async function envelopeAt(treeMap: Map<string, GitTreeEntry>, path: string): Promise<Envelope | undefined> {
		const entry = treeMap.get(path)
		if (!entry || entry.type !== 'blob')
			return undefined
		const blobResult = await git.readBlob(entry.oid)
		if (blobResult.kind !== 'resolved')
			return undefined
		const text = utf8Decoder.decode(blobResult.bytes)
		const split = splitFrontmatter(text)
		if (!split.ok)
			return undefined
		const document = parseFrontmatterDocument(split.frontmatterText, path, { startLine: 2 })
		const decoded = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, path)
		return decoded.envelope ?? undefined
	}

	function ownedPathsOf(treeMap: Map<string, GitTreeEntry> | undefined, envelope: Envelope | undefined): Set<string> {
		const owned = new Set<string>()
		if (!treeMap || !envelope)
			return owned
		owned.add(canonicalPath)
		for (const resource of envelope.resources) {
			if (isLocalResourceLocation(resource.location))
				owned.add(resource.location)
		}
		if (isProject) {
			for (const controlPath of PROJECT_CONTROL_PATHS) {
				if (treeMap.has(controlPath))
					owned.add(controlPath)
			}
		}
		return owned
	}

	let previousTreeMap: Map<string, GitTreeEntry> | undefined
	let previousEnvelope: Envelope | undefined
	let previousChgStatus = new Map<string, Status>()

	const commits: HistoryCommitData[] = []
	const effects: HistoryEffectData[] = []

	for (const oid of oidsOldestFirst) {
		const treeMap = await treeMapAt(oid)
		if (!treeMap)
			return undefined

		const currentEnvelope = await envelopeAt(treeMap, canonicalPath)

		// ---- Aggregate diffing: did this commit change the target's owned paths? ----
		const prevOwned = ownedPathsOf(previousTreeMap, previousEnvelope)
		const curOwned = ownedPathsOf(treeMap, currentEnvelope)
		const changed: string[] = []
		for (const path of new Set([...prevOwned, ...curOwned])) {
			const prevOid = previousTreeMap?.get(path)?.oid
			const curOid = treeMap.get(path)?.oid
			if (prevOid !== curOid)
				changed.push(path)
		}
		if (changed.length > 0)
			commits.push({ oid, changed_paths: changed.sort(compareBytewise) })

		// ---- Engineering effects: newly completed CHGs targeting this Artifact ----
		const currentChgStatus = new Map<string, Status>()
		for (const [path, entry] of treeMap) {
			if (entry.type !== 'blob' || !path.startsWith('.engineering/chg/') || !path.endsWith('.md'))
				continue

			const chgEnvelope = await envelopeAt(treeMap, path)
			if (!chgEnvelope || chgEnvelope.type !== 'change')
				continue
			currentChgStatus.set(chgEnvelope.id, chgEnvelope.status)

			const wasCompleted = previousChgStatus.get(chgEnvelope.id) === 'completed'
			if (chgEnvelope.status !== 'completed' || wasCompleted)
				continue

			for (const relation of chgEnvelope.relations) {
				if (relation.target !== targetId)
					continue
				if (relation.type !== 'introduces' && relation.type !== 'modifies' && relation.type !== 'retires')
					continue

				const liveRecord = byId.get(chgEnvelope.id)
				const chgSummary = liveRecord
					? buildArtifactSummary(liveRecord.envelope, liveRecord.path)
					: buildArtifactSummary(chgEnvelope, path)

				effects.push({
					chg: chgSummary,
					effect: relation.type,
					status_before: previousEnvelope?.status ?? null,
					status_after: currentEnvelope?.status ?? previousEnvelope?.status ?? 'retired',
					commit_oid: oid,
				})
			}
		}

		previousTreeMap = treeMap
		previousEnvelope = currentEnvelope
		previousChgStatus = currentChgStatus
	}

	return { effects, commits }
}

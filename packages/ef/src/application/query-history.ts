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

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, Envelope, Status } from '../domain/model'
import type { GitRepository, GitTreeEntry } from '../git/repository'
import type { HistoryCommitData, HistoryEffectData } from './query-types'
import type { SnapshotArtifactRecord } from './snapshot-validation'
import { decodeEnvelope } from '../domain/envelope'
import { validateStatus } from '../domain/lifecycle'
import { compareBytewise } from '../domain/model'
import { validateRelationEntries } from '../domain/relations'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { buildArtifactSummary, canonicalArtifactPath } from './query-projection'
import { rawArrayField } from './snapshot-raw-fields'

const EF_YAML_PATH = '.engineering/ef.yaml'
const PROJECT_CONTROL_PATHS = [EF_YAML_PATH, '.engineering/.gitignore'] as const
const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

function hasErrorDiagnostic(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some(d => d.severity === 'error')
}

function isLocalResourceLocation(location: string): boolean {
	return !location.startsWith('http://') && !location.startsWith('https://')
}

export interface HistoryOutcome {
	effects: HistoryEffectData[]
	commits: HistoryCommitData[]
}

/**
 * `computeHistory`'s result: `complete` carries the materialized outcome;
 * the two failure kinds distinguish "the required Git history itself is
 * unavailable" from "the history walk touched a path or blob that cannot be
 * trusted" -- previously folded into the same `undefined` and reported as a
 * single `EF-QRY-010` by every caller. `./query.ts`'s `handleHistory` maps
 * these onto the two distinct registered diagnostics the review ruling for
 * this defect class specifies:
 *
 * - `history-unavailable`: the required first-parent history itself could
 *   not be completely materialized (shallow, unresolved, or otherwise
 *   inaccessible Git history), or a historical commit's tree could not be
 *   read mid-walk. This maps to `EF-QRY-010` ("Requested history context is
 *   unavailable", diagnostic-registry.md).
 * - `untrusted-data`: the target's current record sits at a path that
 *   violates its canonical placement (`EF-ID-005`/`EF-ID-014`; see the
 *   authoritative-path check below), or a historical blob this walk needed
 *   exists but cannot be completely read and decoded (unreadable blob,
 *   malformed frontmatter, or an envelope that fails to decode). This maps
 *   to `EF-QRY-013` ("Query cannot produce a complete trustworthy result",
 *   diagnostic-registry.md).
 */
export type ComputeHistoryResult
	= | ({ kind: 'complete' } & HistoryOutcome)
		| { kind: 'history-unavailable' }
		| { kind: 'untrusted-data' }

export async function computeHistory(
	git: GitRepository,
	integrationRefOid: string,
	targetId: string,
	targetType: ArtifactType,
	byId: ReadonlyMap<string, SnapshotArtifactRecord>,
): Promise<ComputeHistoryResult> {
	const historyResult = await git.listFirstParentHistory(integrationRefOid)
	if (historyResult.kind !== 'complete')
		return { kind: 'history-unavailable' }

	const oidsOldestFirst = [...historyResult.oids].reverse()
	const canonicalPath = canonicalArtifactPath(targetType, targetId)
	const isProject = targetType === 'project'

	// History tracks an Artifact aggregate by scanning the *canonical* path
	// derived from (type, id) at each historical commit (see the module
	// docstring: a small, explicitly known candidate path set, not a tree
	// diff). `EF-ID-005` (filename does not match ID) and `EF-ID-014` (file
	// outside its canonical directory) deliberately do NOT gate
	// `graphTrustworthy` (snapshot-validation.ts) -- the declared ID is still
	// unique and correctly decoded, so lookup/relations/etc. over `byId`
	// remain trustworthy even though the file/layout convention is violated.
	// History is different: if the *current* record's actual authoritative
	// path does not match the canonical path this walk is about to scan, the
	// premise the whole aggregate-diffing walk relies on is already broken --
	// the file this ID currently resolves to is not at the path history
	// assumes it occupies, so scanning `canonicalPath` anyway could return an
	// empty or silently partial history for an aggregate whose blob actually
	// exists elsewhere. Treat this as a history-specific blocker instead
	// (`untrusted-data`, not `history-unavailable`: the Git history itself is
	// perfectly readable, only this target's own current placement is not
	// trustworthy).
	const currentRecord = byId.get(targetId)
	if (currentRecord && currentRecord.path !== canonicalPath)
		return { kind: 'untrusted-data' }

	const treeCache = new Map<string, Map<string, GitTreeEntry> | undefined>()
	async function treeMapAt(oid: string): Promise<Map<string, GitTreeEntry> | undefined> {
		if (treeCache.has(oid))
			return treeCache.get(oid)
		const result = await git.readTree(oid)
		const map = result.kind === 'resolved' ? new Map(result.entries.map(entry => [entry.path, entry] as const)) : undefined
		treeCache.set(oid, map)
		return map
	}

	// Distinguishes genuine tree absence (no entry, or a non-blob entry: the
	// path legitimately does not exist as a file at this historical commit --
	// e.g. the Artifact had not been created yet) from an entry that DOES
	// exist as a blob at this commit but could not be completely read and
	// decoded (unreadable blob, malformed frontmatter, or an envelope that
	// fails to decode). The former is a normal, expected input to the walk;
	// the latter means a historical blob this walk needed exists but its
	// content cannot be trusted, which must fail the whole query rather than
	// being silently treated the same as absence (the target could appear to
	// disappear, or a malformed/unreadable CHG could simply be skipped from
	// effects, while the command still reports `complete: true`).
	//
	// A successfully-decoded `envelope` (non-null) does NOT by itself mean the
	// data is trustworthy: `parseFrontmatterDocument`/`decodeEnvelope` still
	// populate `document`/`decoded` with error-severity diagnostics for things
	// like duplicate frontmatter keys (`EF-ENV-005`), an unsupported or
	// mismatched schema (`EF-ENV-008`/`EF-ENV-009`), or a duplicate tag
	// (`EF-ENV-012`) while still returning a usable-looking envelope (e.g. by
	// keeping the last of two duplicate keys). `lifecycle.ts`'s `validateStatus`
	// closes a further gap neither parser checks: an unknown or type-inapplicable
	// `status` value (`EF-LIFE-001`/`EF-LIFE-002`) decodes as a plain string with
	// no diagnostic of its own. Any error-severity finding from either source
	// makes this blob's content untrusted, exactly like an undecodable envelope.
	type EnvelopeLookup
		= | { kind: 'absent' }
			| { kind: 'error' }
			| { kind: 'resolved', envelope: Envelope, mapping: ReturnType<typeof parseFrontmatterDocument>['mapping'] }

	async function envelopeAt(treeMap: Map<string, GitTreeEntry>, path: string): Promise<EnvelopeLookup> {
		const entry = treeMap.get(path)
		if (!entry || entry.type !== 'blob')
			return { kind: 'absent' }
		const blobResult = await git.readBlob(entry.oid)
		if (blobResult.kind !== 'resolved')
			return { kind: 'error' }
		const text = utf8Decoder.decode(blobResult.bytes)
		const split = splitFrontmatter(text)
		if (!split.ok)
			return { kind: 'error' }
		const document = parseFrontmatterDocument(split.frontmatterText, path, { startLine: 2 })
		const decoded = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, path)
		if (!decoded.envelope)
			return { kind: 'error' }
		if (hasErrorDiagnostic(document.diagnostics) || hasErrorDiagnostic(decoded.diagnostics))
			return { kind: 'error' }
		const statusDiagnostics = validateStatus({ type: decoded.envelope.type, status: decoded.envelope.status, id: decoded.envelope.id }, path)
		if (hasErrorDiagnostic(statusDiagnostics))
			return { kind: 'error' }
		return { kind: 'resolved', envelope: decoded.envelope, mapping: document.mapping }
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

	// The bootstrap commit is the first authoritative EF state
	// (11-filesystem-and-config.md: "Its first-parent ancestors MAY be
	// ordinary repository history without EF state. From bootstrap onward, the
	// branch's first-parent EF-bearing commit sequence is the sequence of
	// authoritative EF states."). Until the walk reaches the first commit
	// whose tree contains `.engineering/ef.yaml`, every earlier commit is
	// skipped entirely -- never decoded at `canonicalPath` or scanned for
	// `.engineering/chg/*.md` -- so ordinary pre-EF repository content that
	// happens to sit at an EF-shaped path (a stale Artifact/CHG-looking file
	// predating adoption) can neither fabricate a commit/effect entry nor
	// fail an otherwise-valid query by looking like malformed EF data.
	// `previousTreeMap`/`previousEnvelope`/`previousChgStatus` are left at
	// their initial (empty) values through every skipped commit, so the first
	// commit actually processed -- the bootstrap commit itself -- is diffed
	// exactly as if it were `oidsOldestFirst[0]`.
	let reachedBootstrap = false

	for (const oid of oidsOldestFirst) {
		const treeMap = await treeMapAt(oid)
		if (!treeMap)
			return { kind: 'history-unavailable' }

		if (!reachedBootstrap) {
			const efYamlEntry = treeMap.get(EF_YAML_PATH)
			if (!efYamlEntry || efYamlEntry.type !== 'blob')
				continue
			reachedBootstrap = true
		}

		const currentEnvelopeLookup = await envelopeAt(treeMap, canonicalPath)
		if (currentEnvelopeLookup.kind === 'error')
			return { kind: 'untrusted-data' }
		const currentEnvelope = currentEnvelopeLookup.kind === 'resolved' ? currentEnvelopeLookup.envelope : undefined

		// The canonical path is scanned under the premise that whatever blob
		// sits there IS this target's own envelope. If it decodes to a
		// different declared `id` or `type`, that premise is broken -- some
		// other Artifact's (or malformed) content occupies the path this walk
		// assumes belongs to `targetId` -- and continuing would silently
		// attribute an unrelated envelope's history to this target.
		if (currentEnvelope && (currentEnvelope.id !== targetId || currentEnvelope.type !== targetType))
			return { kind: 'untrusted-data' }

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

			const chgLookup = await envelopeAt(treeMap, path)
			if (chgLookup.kind === 'error')
				return { kind: 'untrusted-data' }
			if (chgLookup.kind === 'absent')
				continue
			const chgEnvelope = chgLookup.envelope
			if (chgEnvelope.type !== 'change')
				continue
			currentChgStatus.set(chgEnvelope.id, chgEnvelope.status)

			const wasCompleted = previousChgStatus.get(chgEnvelope.id) === 'completed'
			if (chgEnvelope.status !== 'completed' || wasCompleted)
				continue

			// `chgEnvelope.relations` is `decodeEnvelope`'s raw-shape decoding of
			// each entry (missing `type`/`target` default to `''`, unknown
			// vocabulary passes through as-is) -- it does not apply
			// `domain/relations.ts`'s own shape/vocabulary/self-relation checks.
			// Re-derive the CHG's true raw `relations` array from the parsed YAML
			// mapping (`snapshot-raw-fields.ts`, exactly as `snapshot-validation.ts`
			// does for its own `chgEffects`) and run it through
			// `validateRelationEntries` so a relation entry with an unrecognized
			// type, invalid shape, or a self-relation can never be mistaken for a
			// genuine `introduces`/`modifies`/`retires` effect.
			const rawRelations = chgLookup.mapping ? rawArrayField(chgLookup.mapping, 'relations') : []
			const relationValidation = validateRelationEntries({ id: chgEnvelope.id, relations: rawRelations }, path)

			for (const relation of relationValidation.entries) {
				if (relation.target !== targetId)
					continue
				if (relation.type !== 'introduces' && relation.type !== 'modifies' && relation.type !== 'retires')
					continue

				// History is defined by the authoritative integration state
				// observed AT THIS COMMIT, not by whatever the CHG's current
				// (possibly since-edited, possibly uncommitted) record says now
				// -- the effect summary is built unconditionally from the
				// historically-decoded `chgEnvelope`/`path` at this `oid`
				// (10-query-and-trace.md history: effects carry the CHG summary
				// from the authoritative integration commit).
				const chgSummary = buildArtifactSummary(chgEnvelope, path)

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

	return { kind: 'complete', effects, commits }
}

/**
 * History lookup execution (10-query-and-trace.md "History Lookup").
 *
 * Walks the captured integration ref's complete first-parent history
 * (oldest to newest) and, for each commit FROM THE BOOTSTRAP BOUNDARY
 * ONWARD, materializes and fully snapshot-validates that commit's COMPLETE
 * authoritative tree (`./snapshot.ts`'s `loadSnapshotFromCommit` plus
 * `./snapshot-validation.ts`'s `validateSnapshot` -- the exact same pipeline
 * every other snapshot/transition validation reuses), rather than decoding
 * only a small hand-picked candidate-path subset of it.
 *
 * Eleventh-round review Finding 2: a prior implementation ran that complete
 * pipeline only ONCE, at the claimed bootstrap boundary commit, and fell back
 * to a hand-maintained set of per-state probes (frontmatter/status decoding,
 * discovery-scope layout scanning, resource-descriptor/local-file-existence
 * checks, CHG body/relation/resource re-validation) for every LATER
 * authoritative commit. Each probe closed one previously-discovered gap, but
 * the class of gap kept recurring: any invariant `validateSnapshot` enforces
 * that the hand-maintained subset did not separately re-implement (a missing
 * required body heading, a corrupted control file, a malformed Resource
 * descriptor anywhere else in the tree, ...) could pass through a LATER
 * commit unnoticed as long as the walk's own narrow probes stayed silent,
 * even though 09-validation.md requires every state admitted to
 * authoritative integration history to satisfy the graph/state invariants.
 *
 * The fix: EVERY consumed authoritative EF-bearing commit (bootstrap
 * included) is now materialized and validated exactly the same way; any
 * error-severity diagnostic anywhere in that commit's COMPLETE validation
 * result makes the whole query `untrusted-data` (warnings/info never do).
 * This is a strictly WIDER trust boundary than before -- it also rejects an
 * error condition on an Artifact wholly unrelated to `targetId`, which is
 * intentional: history must validate the complete authoritative state it
 * consumes via the real validators, not a hand-maintained probe subset scoped
 * only to what one target's aggregate happens to touch. Every per-state probe
 * this fully subsumes (frontmatter/envelope decoding, status applicability,
 * canonical-layout/discovery-scope violations, filename/directory identity,
 * resource descriptor shape and local-file existence, CHG body structure and
 * relation/resource projection fidelity, `ef.yaml`/`.gitignore` control-file
 * validity, invalid-UTF-8 paths or bytes) has been REMOVED; only tracking
 * that genuinely spans MULTIPLE commits -- and could therefore never be
 * proven by validating any single commit in isolation -- remains hand-written
 * below: stable-ID presence/physical-deletion across the walk, CHG lifecycle
 * transition legality and terminal-aggregate freeze across commits, CHG
 * effect classification/coverage against the target's own before/after
 * aggregate transition, and `integration_ref` self-consistency across
 * commits. Each retained check's own doc comment explains why it is
 * cross-commit and not subsumable by validating one commit alone.
 *
 * Eleventh-round review Finding 3: before classifying a commit's net effect
 * on the target's aggregate, the target's own observed status edge
 * (`before` -> `after` across this exact commit boundary) is now validated
 * against `domain/lifecycle.ts`'s own `validateTransition` -- the SAME
 * `ALLOWED_TRANSITIONS` legality and first-authoritative-appearance rules
 * (03-lifecycle.md) `transition-validation.ts` reuses for baseline/proposed
 * comparisons -- so an illegal transition (e.g. `active -> draft`) or an
 * illegal first appearance (e.g. a knowledge Artifact first appearing
 * directly `superseded`/`retired`) can never be laundered into trustworthy
 * history merely because an otherwise-valid completing CHG happens to cover
 * the same commit. A CHG's OWN status sequence is validated separately,
 * against the SAME `ALLOWED_TRANSITIONS` table, by the pre-existing
 * cross-commit `chgLifecycleStatus` tracking below.
 *
 * Performance note: this walk now runs the complete `validateSnapshot`
 * pipeline once per consumed authoritative commit (in addition to the
 * targeted tree/blob reads it already performed for OID-diffing and CHG
 * aggregate fingerprinting), not only once at the boundary. This is a real,
 * accepted cost -- correctness of the trust boundary takes priority over
 * avoiding redundant per-commit materialization for EF Core v1.
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
import type { ProjectSnapshot } from './snapshot'
import type { SnapshotArtifactRecord, SnapshotValidationResult } from './snapshot-validation'
import { validateTransition as validateLifecycleTransition } from '../domain/lifecycle'
import { ALLOWED_TRANSITIONS, compareBytewise, RELATION_COMPATIBILITY, TERMINAL_STATUSES } from '../domain/model'
import { buildArtifactSummary, canonicalArtifactPath } from './query-projection'
import { loadSnapshotFromCommit } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

const EF_YAML_PATH = '.engineering/ef.yaml'
const PROJECT_CONTROL_PATHS = [EF_YAML_PATH, '.engineering/.gitignore'] as const
/**
 * Bootstrap-only state rules (09-validation.md "Bootstrap exception"): no CHG
 * Artifact, and no terminal (`superseded`/`retired`) knowledge Artifact, may
 * be present at the very first EF state. Mirrors `bootstrap-validation.ts`'s
 * own (unexported) `KNOWLEDGE_TYPES` constant of the same name -- duplicated
 * here rather than imported because neither that constant nor the small
 * state-rule loop it drives is exported (see this round's review report for
 * the extraction that would let this module import it instead).
 */
const BOOTSTRAP_KNOWLEDGE_TYPES = new Set(['prd', 'requirement', 'decision', 'policy'])

function hasErrorDiagnostic(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some(d => d.severity === 'error')
}

function isExternalResourceLocation(location: string): boolean {
	return location.startsWith('http://') || location.startsWith('https://')
}

/**
 * Whether `location` is a syntactically valid LOCAL Resource location
 * (06-resources.md "Location classification"/"Local path resolution"), used
 * only to decide the paths this walk treats as part of the target's owned
 * aggregate (`ownedPathsOf` below) and the paths a completed CHG's own
 * terminal-freeze fingerprint covers (`chgAggregateWitnessOf`). This is
 * genuinely cross-commit bookkeeping -- which paths' OIDs to compare between
 * two historical commits -- not a re-validation of whether the location is a
 * WELL-FORMED descriptor (that shape/vocabulary/ownership judgment is
 * `domain/resources.ts`'s own concern, already covered for every artifact by
 * this walk's full per-commit `validateSnapshot` call) -- so it is not
 * subsumed by that validation and stays a narrow syntax-only predicate here.
 */
function isValidLocalResourceLocation(location: string): boolean {
	if (location.length === 0 || isExternalResourceLocation(location))
		return false
	if (location.includes(':') || location.includes('\\'))
		return false
	if (location.startsWith('/') || location.startsWith('~'))
		return false
	return !location.split('/')
		.some(segment => segment === '' || segment === '.' || segment === '..')
}

/**
 * Whether a change from `before` to `after` for `type` requires CHG coverage
 * at all, given that the target's aggregate is already known to have changed
 * this commit (07-change-transactions.md "CHG-required mutations"/
 * "CHG-optional mutations"). Narrowly mirrors
 * `application/transition-validation.ts`'s own (unexported) `requiresChg` --
 * not imported: exporting it would require modifying that module, outside
 * this fix's file scope (see this round's review report for the extraction
 * that would let this module import it instead). This is cross-commit
 * coverage bookkeeping -- whether THIS EXACT transition demands a completing
 * CHG claim in THIS SAME commit -- which no single-snapshot validation can
 * ever prove on its own.
 */
function requiresChgForTarget(type: ArtifactType, before: Status | undefined, after: Status): boolean {
	if (type === 'change')
		return false
	if (before === undefined)
		return after !== 'draft'
	if (before === 'draft')
		return after === 'active'
	if (TERMINAL_STATUSES.includes(before))
		return false
	return true
}

/**
 * A fingerprint of one CHG's own aggregate at `path` in `treeMap` -- its file
 * blob OID plus every declared local Resource location's own OID, sorted for
 * stable comparison -- used to detect a same-status (`completed ->
 * completed`, `retired -> retired`) content mutation the cross-commit
 * `chgLifecycleStatus` map's status-only tracking would otherwise never
 * observe. Comparing two historical commits' fingerprints is inherently
 * cross-commit; no single commit's own `validateSnapshot` result can prove a
 * frozen CHG's content stayed byte-identical to what it was several commits
 * ago.
 */
function chgAggregateWitnessOf(treeMap: ReadonlyMap<string, GitTreeEntry>, path: string, envelope: Envelope): string {
	const fileOid = treeMap.get(path)?.oid ?? ''
	const resourceOids = envelope.resources
		.filter(resource => isValidLocalResourceLocation(resource.location))
		.map(resource => `${resource.location}=${treeMap.get(resource.location)?.oid ?? ''}`)
		.sort(compareBytewise)
	return JSON.stringify({ fileOid, resourceOids })
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
 *   inaccessible Git history), a historical commit's tree could not be read
 *   mid-walk, an authoritative commit's COMPLETE snapshot materialization
 *   failed due to an execution/read failure (Git unavailable, or a tree/blob
 *   already proven to exist that then failed to read), or the walked history
 *   never contains a commit whose tree even contains `.engineering/ef.yaml`
 *   at all -- no authoritative EF history exists on this ref at all. This
 *   maps to `EF-QRY-010` ("Requested history context is unavailable",
 *   diagnostic-registry.md).
 * - `untrusted-data`: the target's current record sits at a path that
 *   violates its canonical placement (`EF-ID-005`/`EF-ID-014`; see the
 *   authoritative-path check below), the claimed bootstrap boundary commit
 *   exists but is not a valid, complete bootstrap (an undecodable/wrong-ref
 *   `ef.yaml`, ANY error-severity finding anywhere in that commit's complete
 *   snapshot validation, or a bootstrap-only state rule violation -- a CHG
 *   Artifact, or a terminal knowledge Artifact, present before the first EF
 *   state), a LATER authoritative EF-bearing commit whose complete snapshot
 *   validation carries ANY error-severity finding at all (Finding 2 -- this
 *   subsumes what used to be a hand-maintained per-state probe list:
 *   malformed/undecodable envelopes, invalid status, canonical-layout or
 *   discovery-scope violations, filename/directory identity mismatches,
 *   malformed or non-existent-file Resource descriptors, invalid CHG body
 *   structure, lossy relation/Resource projections, invalid-UTF-8 paths or
 *   bytes, and a corrupted/missing/non-canonical control file), a LATER
 *   commit whose `ef.yaml` declares a DIFFERENT `integration_ref` than the
 *   one this walk's own bootstrap commit fixed (Finding 11 self-consistency,
 *   11-filesystem-and-config.md: "`integration_ref` is fixed by bootstrap and
 *   MUST NOT change within Core v1"), an illegal lifecycle transition or
 *   illegal first authoritative appearance on the target's own status edge
 *   across one commit boundary (Finding 3, 03-lifecycle.md
 *   `ALLOWED_TRANSITIONS` and "First authoritative appearance"), or one of
 *   the genuinely cross-commit conditions no single commit's validation can
 *   prove alone: the target ID physically disappearing after having
 *   genuinely appeared (02-identity.md permanent retention), a CHG's own
 *   status regressing illegally or its terminal aggregate mutating while its
 *   status stays terminal, a completing CHG's declared effect not matching
 *   the target's actual net effect across this exact commit boundary, more
 *   than one completing CHG claiming the same target in the same commit, or
 *   a changed CHG-required target with no completing CHG claim at all. This
 *   maps to `EF-QRY-013` ("Query cannot produce a complete trustworthy
 *   result", diagnostic-registry.md).
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
	/**
	 * The exact ref NAME (e.g. `refs/heads/main`) `integrationRefOid` was
	 * resolved from -- the ref this history walk was asked to walk.
	 * 11-filesystem-and-config.md: "`integration_ref` is fixed by bootstrap
	 * and MUST NOT change within Core v1." (Finding 11). When supplied, the
	 * bootstrap boundary commit's own decoded `ef.yaml` MUST declare exactly
	 * this ref, else `untrusted-data` -- this is what stops a config that was
	 * schema-validly edited to select a DIFFERENT ref (whose own history
	 * happens to carry an otherwise-plausible bootstrap) from being silently
	 * accepted merely because that other ref's history is internally
	 * consistent.
	 *
	 * Independently of whether this argument is supplied, EVERY later
	 * authoritative EF-bearing commit in the SAME walk whose `ef.yaml` blob
	 * changes is always required to still declare the SAME `integration_ref`
	 * the walk's own bootstrap commit declared (see `bootstrapIntegrationRef`
	 * below) -- an in-history retarget partway through one ref's own history
	 * is detected on that self-consistency alone, with no need for this
	 * parameter at all.
	 *
	 * Optional: `./query.ts`'s `handleHistory` supplies it via
	 * `HistoryQueryContext.integrationRef` (populated by
	 * `cli/commands/query.ts`'s own `resolveRef` call, the same ref name used
	 * to obtain `integrationRefOid`). Remains optional so a caller without a
	 * ref name on hand degrades gracefully to the self-consistency check
	 * alone, rather than failing every history query closed.
	 */
	expectedIntegrationRef?: string,
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

	function ownedPathsOf(treeMap: Map<string, GitTreeEntry> | undefined, envelope: Envelope | undefined): Set<string> {
		const owned = new Set<string>()
		if (!treeMap || !envelope)
			return owned
		owned.add(canonicalPath)
		for (const resource of envelope.resources) {
			if (isValidLocalResourceLocation(resource.location))
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

	interface MaterializedCommit {
		snapshot: ProjectSnapshot
		validation: SnapshotValidationResult
	}
	type MaterializeOutcome = { kind: 'unavailable' } | { kind: 'ready', commit: MaterializedCommit }

	/**
	 * Finding 2: materialize `oid`'s COMPLETE tree and run it through the SAME
	 * `validateSnapshot` pipeline every other snapshot/transition validation
	 * reuses -- the single per-commit trust primitive every check below is
	 * built on, replacing the prior hand-maintained per-state probe list.
	 */
	async function materializeAndValidate(oid: string): Promise<MaterializeOutcome> {
		const loadResult = await loadSnapshotFromCommit(git, oid)
		if (!loadResult.ok)
			return { kind: 'unavailable' }
		const validation = validateSnapshot(loadResult.snapshot)
		return { kind: 'ready', commit: { snapshot: loadResult.snapshot, validation } }
	}

	let previousTreeMap: Map<string, GitTreeEntry> | undefined
	let previousEnvelope: Envelope | undefined
	// Finding 4 (tenth-round review; still cross-commit, not subsumed by
	// single-commit validation): whether `targetId` has EVER been observed
	// present (at its own canonical path, with matching type) at any consumed
	// commit so far -- never reset per commit, unlike `previousEnvelope`
	// (which only reflects the immediately preceding commit). Once true, a
	// later commit where the target is absent is a physical deletion of an
	// issued ID (02-identity.md forbids this), not ordinary "not yet created"
	// absence, and must fail the query rather than silently resetting
	// `previousEnvelope` back to `undefined` and letting a later
	// re-appearance be accepted as a fresh `introduces`.
	let targetEverAppeared = false
	// Finding 5 (tenth-round review; 03-lifecycle.md `ALLOWED_TRANSITIONS`;
	// 07-change-transactions.md): every CHG id's own MOST RECENTLY OBSERVED
	// status across the WHOLE walk so far -- never reset per commit. This is
	// the CHG analogue of the target-side Finding 3 check below, and is
	// genuinely cross-commit: no single commit's own validation can know
	// whether ITS status for a given CHG id is a legal successor of some
	// EARLIER commit's status for that same id.
	const chgLifecycleStatus = new Map<string, Status>()
	/**
	 * A terminal (`completed`/`retired`) CHG's own aggregate (its file bytes
	 * plus its owned local Resource content) is frozen after integration,
	 * exactly like a terminal knowledge Artifact
	 * (07-change-transactions.md: "its frontmatter, body, and owned Resources
	 * are frozen after integration"). `chgLifecycleStatus` alone only tracks
	 * STATUS -- a same-status recurrence (`completed -> completed`,
	 * `retired -> retired`) with the file OID or a declared local Resource's
	 * OID actually different is a same-status mutation that map would never
	 * observe on its own; comparing this commit's fingerprint against an
	 * EARLIER commit's is inherently cross-commit. Keyed by CHG id; holds a
	 * fingerprint of `{ fileOid, resourceOids }` captured the moment the id's
	 * status is observed terminal, compared against every later same-status
	 * occurrence.
	 */
	const chgTerminalWitness = new Map<string, string>()

	const commits: HistoryCommitData[] = []
	const effects: HistoryEffectData[] = []

	// The bootstrap commit is the first authoritative EF state
	// (11-filesystem-and-config.md: "Its first-parent ancestors MAY be
	// ordinary repository history without EF state. From bootstrap onward, the
	// branch's first-parent EF-bearing commit sequence is the sequence of
	// authoritative EF states."). The CLAIMED bootstrap boundary is the FIRST
	// first-parent commit whose tree contains the `.engineering/ef.yaml` path
	// AT ALL, regardless of its mode/type: per the bootstrap-validation
	// contract (EF-VAL-009, `bootstrap-validation.ts`'s
	// `pathExistsInFirstParentHistory` probe), any historical `ef.yaml` path
	// -- valid, invalid, or not even a regular file -- asserts an EF state at
	// that commit, so the walk MUST NEVER look past it hoping a later commit
	// is "more valid". Earlier commits (the path genuinely absent) are
	// skipped entirely -- never materialized or validated at all -- so
	// ordinary pre-EF repository content that happens to sit at an EF-shaped
	// path (a stale Artifact/CHG-looking file predating adoption) can neither
	// fabricate a commit/effect entry nor fail an otherwise-valid query.
	//
	// Once the boundary is claimed, it is evaluated exactly once, with no
	// fallback to a later commit either way:
	// - a read/execution failure while resolving or decoding ANY blob the
	//   boundary's complete snapshot materialization needs makes the required
	//   history itself unavailable (`history-unavailable`, `EF-QRY-010`) -- a
	//   transient read failure at the true boundary must never be papered over
	//   by silently accepting a later commit's successful read as though
	//   history started there instead (that would be a silent late start).
	// - a structural/validity failure -- `ef.yaml` fails to decode as a valid
	//   `ef/config@1` configuration, declares the wrong `integration_ref`, the
	//   claimed boundary's COMPLETE tree carries any error-severity finding at
	//   all (Finding 2), or violates a bootstrap-only state rule (no CHG
	//   Artifact, no terminal knowledge Artifact) -- makes this claimed
	//   boundary untrustworthy (`untrusted-data`, `EF-QRY-013`): a pre-EF
	//   commit that merely happens to carry a syntactically valid config (or
	//   any other partial EF-shaped state) but is not a genuine, complete
	//   bootstrap must be reported as untrusted, never silently skipped in
	//   favor of a later commit.
	//
	// `previousTreeMap`/`previousEnvelope`/`targetEverAppeared`/
	// `chgLifecycleStatus` are left at their initial (empty) values through
	// every skipped pre-boundary commit, so the first commit actually
	// processed -- the bootstrap commit itself -- is diffed exactly as if it
	// were `oidsOldestFirst[0]`.
	let reachedBootstrap = false
	// The `integration_ref` the walk's OWN bootstrap commit declared -- the
	// baseline every later authoritative EF-bearing commit's own `ef.yaml` is
	// compared against (Finding 11's ALWAYS-ON self-consistency requirement,
	// independent of whether `expectedIntegrationRef` was supplied at all).
	let bootstrapIntegrationRef: string | undefined

	type BootstrapBoundaryOutcome
		= | { kind: 'not-present' }
			| { kind: 'read-error' }
			| { kind: 'invalid' }
			| { kind: 'valid', commit: MaterializedCommit }

	/**
	 * A decodable `ef.yaml` plus a minimal PROJECT witness is NOT sufficient
	 * proof that the claimed boundary commit is a genuine, COMPLETE bootstrap
	 * (09-validation.md "Bootstrap exception"; 11-filesystem-and-config.md).
	 * Core bootstrap requires complete snapshot validation, every required
	 * control file in canonical form, no terminal knowledge Artifact, and no
	 * CHG Artifact at all -- so the claimed boundary's ENTIRE tree is
	 * materialized and validated via `materializeAndValidate` (Finding 2),
	 * plus the bootstrap-only state rules `bootstrap-validation.ts`'s own
	 * `validateBootstrap` applies (EF-VAL-010: no CHG, no terminal
	 * knowledge). `validateBootstrap` itself is not called here -- it also
	 * drives ref-resolution/parentage orchestration for a caller-supplied
	 * CANDIDATE commit, which this walk has no use for: the boundary commit
	 * here is already GIVEN by the walk's own first-parent history scan, not
	 * a proposal needing its own proof of ref/parentage.
	 */
	async function evaluateBootstrapBoundary(treeMap: Map<string, GitTreeEntry>, oid: string): Promise<BootstrapBoundaryOutcome> {
		if (!treeMap.has(EF_YAML_PATH))
			return { kind: 'not-present' }

		// From here on, this commit IS the claimed boundary -- every path below
		// returns 'invalid' or 'read-error', never falls through to let the
		// caller consider a later commit instead.
		const materialized = await materializeAndValidate(oid)
		if (materialized.kind === 'unavailable')
			// `materializeAndValidate` fails this way only on a genuine
			// execution/read problem (Git unavailable, or a tree/blob already
			// proven to exist that then fails to read) -- never merely because
			// the boundary's content is invalid -- so this is
			// `history-unavailable`, mirroring every other read/execution
			// failure this probe already treats that way.
			return { kind: 'read-error' }

		const { snapshot, validation } = materialized.commit
		const config = snapshot.config.config
		if (!config)
			return { kind: 'invalid' }
		// Finding 11: `integration_ref` is fixed by bootstrap and MUST NOT
		// change within Core v1 (11-filesystem-and-config.md). When the caller
		// told us which ref it selected, a bootstrap config that is otherwise
		// perfectly valid but declares a DIFFERENT ref is exactly as
		// untrustworthy for this purpose as a config that fails to decode at
		// all -- accepting it would let a config that was schema-validly
		// edited to select a different ref be silently accepted merely
		// because THAT ref's own history happens to be internally consistent.
		if (expectedIntegrationRef !== undefined && config.repository.integrationRef !== expectedIntegrationRef)
			return { kind: 'invalid' }

		if (hasErrorDiagnostic(validation.diagnostics))
			return { kind: 'invalid' }

		// Bootstrap-only state rules (mirrors `bootstrap-validation.ts`'s own
		// `validateBootstrap` loop over `validation.byId`): no CHG Artifact, and
		// no terminal (`superseded`/`retired`) knowledge Artifact, may be
		// present before the first EF state.
		for (const record of validation.byId.values()) {
			if (record.type === 'change')
				return { kind: 'invalid' }
			if (BOOTSTRAP_KNOWLEDGE_TYPES.has(record.type) && (record.status === 'superseded' || record.status === 'retired'))
				return { kind: 'invalid' }
		}

		bootstrapIntegrationRef = config.repository.integrationRef
		return { kind: 'valid', commit: materialized.commit }
	}

	for (const oid of oidsOldestFirst) {
		const treeMap = await treeMapAt(oid)
		if (!treeMap)
			return { kind: 'history-unavailable' }

		// Captured BEFORE `reachedBootstrap` is (possibly) flipped `true`
		// below, so this is `true` on exactly the one commit that is this
		// walk's OWN bootstrap boundary -- the one commit where
		// `previousEnvelope`/`previousTreeMap` are still at their initial
		// (pre-loop) `undefined` value. "Atomic project bootstrap" is
		// explicitly CHG-optional (07-change-transactions.md), so the
		// exactly-once coverage check below never demands CHG coverage for
		// the very state bootstrap itself establishes, and the Finding 3
		// first-appearance check below never demands an `introduces` CHG for
		// a knowledge Artifact first appearing `active` at bootstrap either.
		const isBootstrapCommit = !reachedBootstrap

		let commitValidation: MaterializedCommit

		if (!reachedBootstrap) {
			const boundary = await evaluateBootstrapBoundary(treeMap, oid)
			if (boundary.kind === 'not-present')
				continue
			if (boundary.kind === 'read-error')
				return { kind: 'history-unavailable' }
			if (boundary.kind === 'invalid')
				return { kind: 'untrusted-data' }
			reachedBootstrap = true
			commitValidation = boundary.commit
		}
		else {
			// Finding 2: every later authoritative commit is materialized and
			// fully snapshot-validated exactly like the boundary commit was --
			// no narrower, hand-maintained probe subset.
			const materialized = await materializeAndValidate(oid)
			if (materialized.kind === 'unavailable')
				return { kind: 'history-unavailable' }
			commitValidation = materialized.commit

			if (hasErrorDiagnostic(commitValidation.validation.diagnostics))
				return { kind: 'untrusted-data' }

			// Finding 11: `integration_ref` is fixed by bootstrap and MUST NOT
			// change within Core v1 -- checked here regardless of whether
			// `expectedIntegrationRef` was supplied at all, purely against
			// `bootstrapIntegrationRef` (this SAME walk's own bootstrap
			// commit's declared ref). `commitValidation.snapshot.config.config`
			// is guaranteed non-null here: the `hasErrorDiagnostic` check just
			// above already returned `untrusted-data` for any commit whose
			// config is missing or fails to decode (`EF-VAL-007`/`EF-FS-001`,
			// both error-severity).
			const declaredIntegrationRef = commitValidation.snapshot.config.config!.repository.integrationRef
			if (declaredIntegrationRef !== bootstrapIntegrationRef)
				return { kind: 'untrusted-data' }
		}

		const targetRecord = commitValidation.validation.byId.get(targetId)
		// The canonical-path premise this whole aggregate-diffing walk relies
		// on is that `byId.get(targetId)` (if present) is `targetId`'s own
		// content. `validateSnapshot`'s `byId` is keyed by declared `id`
		// regardless of path, and any duplicate-ID or wrong-path/wrong-directory
		// placement anywhere in the tree (`EF-ID-004`/`005`/`014`) is already an
		// error-severity finding the gate above returned `untrusted-data` for --
		// so a record reaching this point is already known to sit at its own
		// canonical path. Comparing `targetRecord.type` against `targetType` is
		// a residual defensive check: given `validateIdSyntax`'s prefix-to-type
		// binding, a mismatch here should already be unreachable without an
		// accompanying error, but this walk still refuses to silently attribute
		// a differently-typed record's content to `targetId`'s history.
		if (targetRecord && targetRecord.type !== targetType)
			return { kind: 'untrusted-data' }
		const currentEnvelope = targetRecord && targetRecord.type === targetType ? targetRecord.envelope : undefined

		if (currentEnvelope === undefined && targetEverAppeared)
			// `targetId` was genuinely present in an earlier consumed commit and
			// is now absent -- a physical deletion of an issued ID, never a
			// legitimate "not yet created" state at this point in the walk.
			return { kind: 'untrusted-data' }
		if (currentEnvelope !== undefined)
			targetEverAppeared = true

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
		const targetContentChanged = changed.length > 0

		// A terminal (`superseded`/`retired`/`completed`) target's own
		// aggregate is byte-frozen (05-supersession.md / 06-resources.md).
		// Once BOTH the previous and current commit's status are terminal, ANY
		// owned-path content change is untrustworthy REGARDLESS of what any
		// completing CHG in this commit claims -- checked here, before the CHG
		// scan below even runs, so a completing CHG declaring `modifies` for an
		// already-terminal target can never paper over this violation. This is
		// cross-commit (it compares THIS commit's status/content against the
		// PREVIOUS commit's), so it is not subsumed by validating either
		// commit alone.
		if (
			previousEnvelope !== undefined
			&& currentEnvelope !== undefined
			&& TERMINAL_STATUSES.includes(previousEnvelope.status)
			&& TERMINAL_STATUSES.includes(currentEnvelope.status)
			&& targetContentChanged
		) {
			return { kind: 'untrusted-data' }
		}

		// ---- CHG scan: lifecycle bookkeeping and this commit's qualifying effect candidates ----
		// This commit's `validateSnapshot` result already discovered, decoded,
		// and shape/vocabulary-validated every CHG in the discovery scope
		// (`commitValidation.validation.byId`, filtered to `type === 'change'`)
		// -- no separate raw-path scan, filename check, relation
		// re-validation, or body/resource re-validation is needed here; any
		// error on any of those would already have failed the whole commit via
		// the gate above (Finding 2).
		const presentChgIds = new Set<string>()
		interface QualifyingCandidate {
			record: SnapshotArtifactRecord
			type: 'introduces' | 'modifies' | 'retires'
		}
		const qualifyingCandidates: QualifyingCandidate[] = []

		for (const record of commitValidation.validation.byId.values()) {
			if (record.type !== 'change')
				continue
			presentChgIds.add(record.id)

			// Finding 5 (03-lifecycle.md `ALLOWED_TRANSITIONS`): `priorStatus`
			// is this CHG id's MOST RECENTLY OBSERVED status across the ENTIRE
			// walk so far. A first appearance (`priorStatus === undefined`) MAY
			// itself be `completed` or `retired` directly. Once an id HAS
			// appeared, its status sequence must obey Core's own lifecycle
			// rules: a terminal status is frozen, and any other status change
			// must be one of the type's own `ALLOWED_TRANSITIONS`.
			const priorStatus = chgLifecycleStatus.get(record.id)
			if (priorStatus !== undefined && priorStatus !== record.status) {
				const isLegalTransition = !TERMINAL_STATUSES.includes(priorStatus)
					&& ALLOWED_TRANSITIONS.change.some(([from, to]) => from === priorStatus && to === record.status)
				if (!isLegalTransition)
					return { kind: 'untrusted-data' }
			}

			// A terminal CHG's own aggregate is frozen -- a same-status
			// recurrence whose fingerprint no longer matches the one captured
			// the last time this id's status was observed is a same-status
			// mutation `chgLifecycleStatus`'s status-only map would never see.
			if (TERMINAL_STATUSES.includes(record.status)) {
				const currentWitness = chgAggregateWitnessOf(treeMap, record.path, record.envelope)
				if (priorStatus === record.status) {
					const priorWitness = chgTerminalWitness.get(record.id)
					if (priorWitness !== undefined && priorWitness !== currentWitness)
						return { kind: 'untrusted-data' }
				}
				chgTerminalWitness.set(record.id, currentWitness)
			}

			const wasCompleted = priorStatus === 'completed'
			chgLifecycleStatus.set(record.id, record.status)
			if (record.status !== 'completed' || wasCompleted)
				continue

			const effectRelationsOnTarget = record.relations.filter(
				(relation): relation is typeof relation & { type: 'introduces' | 'modifies' | 'retires' } =>
					relation.target === targetId
					&& (relation.type === 'introduces' || relation.type === 'modifies' || relation.type === 'retires'),
			)

			// 04-relations.md `RELATION_COMPATIBILITY`; EF-CHG-017: an effect
			// relation's (source `change`, `type`, target type) triple must
			// satisfy the SAME compatibility matrix `domain/relations.ts`'s own
			// `validateRelationGraph` applies for the current graph -- but
			// `validateRelationGraph` deliberately EXCLUDES a CHG-effect
			// relation targeting another CHG from that check (it treats that
			// case as EF-CHG-017's own concern, which only
			// `transition-validation.ts` computes), so this history walk's own
			// target-type-specific compatibility check remains necessary here,
			// and is not subsumed by this commit's `validateSnapshot` result.
			if (effectRelationsOnTarget.some(relation => !RELATION_COMPATIBILITY[relation.type].targets.includes(targetType)))
				return { kind: 'untrusted-data' }

			if (effectRelationsOnTarget.length > 0) {
				// `EF-REL-006` (a literal duplicate `(type, target)` pair) is
				// already an error-severity finding this commit's `validateSnapshot`
				// result would have caught above. This checks a DIFFERENT
				// condition it does NOT check: one CHG declaring TWO DIFFERENT
				// effect types for the SAME target (e.g. both `introduces` AND
				// `modifies` -> REQ-001) -- not a duplicate pair, so both entries
				// would otherwise reach the emission loop below, making this walk
				// emit two conflicting authoritative effects for the same commit.
				const qualifyingRelationTypes = new Set(effectRelationsOnTarget.map(relation => relation.type))
				if (qualifyingRelationTypes.size > 1)
					return { kind: 'untrusted-data' }

				qualifyingCandidates.push({ record, type: effectRelationsOnTarget[0]!.type })
			}
		}

		// Every issued CHG id, once observed at any status, must remain in the
		// authoritative files from that point on (02-identity.md permanent
		// retention) -- cross-commit: no single commit's own validation can
		// know an id was PREVIOUSLY observed.
		for (const chgId of chgLifecycleStatus.keys()) {
			if (!presentChgIds.has(chgId))
				return { kind: 'untrusted-data' }
		}

		// Eleventh-round review Finding 3 (03-lifecycle.md `ALLOWED_TRANSITIONS`;
		// "First authoritative appearance"): the target's own observed status
		// edge across THIS EXACT commit boundary must itself be a legal
		// lifecycle transition (or a legal first appearance), independently of
		// whatever effect a completing CHG in this same commit declares.
		// Reuses `domain/lifecycle.ts`'s own `validateTransition` -- the exact
		// legality/first-appearance rules `transition-validation.ts` applies
		// for baseline/proposed comparisons -- so this walk never re-derives
		// the transition or first-appearance tables itself. Must run BEFORE
		// net-effect classification below: an illegal transition (e.g. `active
		// -> draft`) or illegal first appearance (e.g. a knowledge Artifact
		// first appearing directly `superseded`/`retired`) must never be
		// laundered into trustworthy history merely because an otherwise-valid
		// completing CHG happens to cover the same commit's content change.
		if (currentEnvelope !== undefined) {
			const introducedByCompletedChg = qualifyingCandidates.some(candidate => candidate.type === 'introduces')
			const transitionDiagnostics = validateLifecycleTransition({
				type: targetType,
				before: previousEnvelope?.status,
				after: currentEnvelope.status,
				id: targetId,
				path: canonicalPath,
				introducedByCompletedChg,
				isProjectBootstrap: isBootstrapCommit,
			})
			if (hasErrorDiagnostic(transitionDiagnostics))
				return { kind: 'untrusted-data' }
		}

		// The target's own aggregate transition ACROSS THIS EXACT COMMIT
		// boundary (07-change-transactions.md net-effect classification):
		// absent -> present is `introduces`; present -> `status: retired`
		// (genuinely, not already retired) is `retires`; present -> present
		// with the aggregate's own content actually changed is `modifies`;
		// anything else matches none of the three effect types.
		const actualEffect: 'introduces' | 'modifies' | 'retires' | undefined
			= previousEnvelope === undefined && currentEnvelope !== undefined
				? 'introduces'
				: previousEnvelope !== undefined && currentEnvelope !== undefined
					&& currentEnvelope.status === 'retired' && previousEnvelope.status !== 'retired'
					? 'retires'
					: previousEnvelope !== undefined && currentEnvelope !== undefined && targetContentChanged
						? 'modifies'
						: undefined

		// A completing CHG's declared effect FACT is never taken on trust
		// alone -- it must match the target's own before/after aggregate
		// transition ACROSS THIS EXACT COMMIT boundary (`retires` requires a
		// GENUINE transition INTO `retired`, not merely "currently retired",
		// which an already-terminal, byte-identical target would also
		// satisfy).
		const pendingEffectsThisCommit: HistoryEffectData[] = []
		for (const candidate of qualifyingCandidates) {
			if (candidate.type !== actualEffect)
				return { kind: 'untrusted-data' }

			// History is defined by the authoritative integration state
			// observed AT THIS COMMIT, not by whatever the CHG's current
			// (possibly since-edited, possibly uncommitted) record says now --
			// the effect summary is built unconditionally from the
			// historically-decoded envelope/path at this `oid`.
			const chgSummary = buildArtifactSummary(candidate.record.envelope, candidate.record.path)
			pendingEffectsThisCommit.push({
				chg: chgSummary,
				effect: candidate.type,
				status_before: previousEnvelope?.status ?? null,
				status_after: currentEnvelope?.status ?? previousEnvelope?.status ?? 'retired',
				commit_oid: oid,
			})
		}

		// More than one completing CHG's qualifying claim on `targetId` at
		// this SAME integration boundary is exactly the exactly-once violation
		// Core's own commit-time validation exists to prevent (EF-CHG-007).
		if (pendingEffectsThisCommit.length > 1)
			return { kind: 'untrusted-data' }

		// A changed, CHG-required target with no completing CHG claim in this
		// SAME commit (07-change-transactions.md "CHG-required mutations";
		// exactly-once coverage). Exempted on the BOOTSTRAP commit itself
		// ("atomic project bootstrap" is CHG-optional).
		if (
			!isBootstrapCommit
			&& actualEffect !== undefined
			&& currentEnvelope !== undefined
			&& requiresChgForTarget(targetType, previousEnvelope?.status, currentEnvelope.status)
			&& pendingEffectsThisCommit.length === 0
		) {
			return { kind: 'untrusted-data' }
		}

		effects.push(...pendingEffectsThisCommit)

		previousTreeMap = treeMap
		previousEnvelope = currentEnvelope
	}

	// The walk never found a commit whose tree contained `.engineering/ef.yaml`
	// AT ALL: the configured integration ref's ENTIRE first-parent history is
	// pre-EF. (A commit that DOES contain the path -- even an invalid or
	// non-regular one -- would already have claimed the boundary above and
	// returned `untrusted-data` instead of reaching here.) No authoritative EF
	// state exists on this ref at all, so the required history this query
	// needs does not exist --
	// `history-unavailable` (`EF-QRY-010`) -- rather than the misleadingly
	// ordinary-looking `{ kind: 'complete', effects: [], commits: [] }` a
	// caller could mistake for "this Artifact simply has no history yet".
	if (!reachedBootstrap)
		return { kind: 'history-unavailable' }

	return { kind: 'complete', effects, commits }
}

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
 * validity, invalid-UTF-8 paths or bytes) has been REMOVED.
 *
 * Twelfth-round review Finding 1: Finding 2 above only ever proved that EACH
 * commit's OWN snapshot is internally valid in isolation. It did not prove
 * the GRAPH-WIDE BEFORE/AFTER transition invariants two adjacent authoritative
 * commits must jointly satisfy (09-validation.md "Transition scope"): CHG
 * net-effect truthfulness and exactly-once coverage for EVERY target (not
 * only the one queried), supersession atomicity, implicit retargeting, and
 * lifecycle transition legality for every id, not only `targetId`. A prior
 * implementation re-derived a hand-maintained, TARGET-SCOPED subset of these
 * same checks instead (only `targetId`'s own CHG effect, coverage, and
 * lifecycle edge) -- so a commit that was truthful for the queried target but
 * transaction-invalid for some OTHER target (a false `retires` on an
 * unrelated, byte-identical Artifact; an uncovered active mutation on an
 * Artifact nobody queried) silently passed as `complete`, even though the
 * REAL commit-time transaction validator (`transition-validation.ts`) would
 * have rejected that same commit outright.
 *
 * The fix: `transition-validation.ts` exports its graph-wide before/after
 * comparison core as `evaluateTransitionBoundary` -- a pure function over two
 * already-validated snapshots, with no ref/parentage orchestration of its
 * own. This walk now runs that SAME core over every adjacent pair of
 * consumed authoritative boundaries (the bootstrap commit paired with the
 * next commit, that commit paired with the next, and so on); any
 * error-severity diagnostic it returns makes the whole query `untrusted-data`,
 * exactly like a real commit-time transaction would have rejected the same
 * boundary. This fully subsumes the tenth/eleventh-round hand-maintained,
 * TARGET-SCOPED mechanisms it replaces: per-target CHG effect
 * truthfulness/coverage/exactly-once claims, CHG lifecycle transition
 * legality and terminal-aggregate freeze tracking, the target's own
 * lifecycle-transition-legality check (Finding 3 below), and issued-ID
 * permanent-retention tracking -- all of these are graph-wide invariants the
 * shared core already proves for every id, not only `targetId`. Only what the
 * shared core CANNOT know is retained, hand-written, below: the
 * requested-target projection itself (which commits/paths belong to
 * `targetId`'s own aggregate), extracting WHICH already-validated CHG effect
 * (if any) belongs to `targetId` from a validated boundary, and
 * `integration_ref` self-consistency across the whole walk (the shared core
 * has no notion of "the ref this walk itself started from").
 *
 * Bootstrap itself has no "before" side (no synthetic baseline is invented
 * for it; 09-validation.md's bootstrap exception is validated on its own
 * terms, unchanged from Finding 2) -- the shared core only ever runs between
 * the bootstrap commit and the next consumed commit onward.
 *
 * Performance note: this walk now runs the complete `validateSnapshot`
 * pipeline once per consumed authoritative commit (in addition to the
 * targeted tree/blob reads it already performed for OID-diffing), plus the
 * shared graph-wide comparison core once per adjacent pair, not only once at
 * the boundary. This is a real, accepted cost -- correctness of the trust
 * boundary takes priority over avoiding redundant per-commit materialization
 * for EF Core v1.
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
import type { ArtifactType, Envelope } from '../domain/model'
import type { GitRepository, GitTreeEntry } from '../git/repository'
import type { HistoryCommitData, HistoryEffectData } from './query-types'
import type { ProjectSnapshot } from './snapshot'
import type { SnapshotArtifactRecord, SnapshotValidationResult } from './snapshot-validation'
import type { TransitionBoundarySide } from './transition-validation'
import { compareBytewise } from '../domain/model'
import { buildArtifactSummary, canonicalArtifactPath } from './query-projection'
import { loadSnapshotFromCommit } from './snapshot'
import { validateSnapshot } from './snapshot-validation'
import { evaluateTransitionBoundary } from './transition-validation'

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
 * aggregate (`ownedPathsOf` below) for the requested-target projection's own
 * OID-diffing. This is genuinely cross-commit bookkeeping -- which paths'
 * OIDs to compare between two historical commits -- not a re-validation of
 * whether the location is a WELL-FORMED descriptor (that shape/vocabulary/
 * ownership judgment is `domain/resources.ts`'s own concern, already covered
 * for every artifact by this walk's full per-commit `validateSnapshot` call)
 * -- so it is not subsumed by that validation and stays a narrow syntax-only
 * predicate here. Terminal-aggregate freeze fingerprinting itself is no
 * longer a separate mechanism this walk maintains -- it is one of the
 * graph-wide invariants `evaluateTransitionBoundary` (twelfth-round review
 * Finding 1) now proves directly over each commit's own decoded content.
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
 * Project-relative path -> blob OID for every BLOB entry in `treeMap`
 * (directory/tree entries excluded), for `evaluateTransitionBoundary`'s own
 * Resource/control-file/CHG-aggregate content-fingerprinting -- the same
 * per-path OID index `transition-validation.ts`'s own (private) `materialize`
 * builds for its baseline/proposed commits, assembled here from this walk's
 * own already-fetched `treeMap` instead of a second tree read.
 */
function oidByPathFrom(treeMap: ReadonlyMap<string, GitTreeEntry>): ReadonlyMap<string, string> {
	const oidByPath = new Map<string, string>()
	for (const [path, entry] of treeMap) {
		if (entry.type === 'blob')
			oidByPath.set(path, entry.oid)
	}
	return oidByPath
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
 *   MUST NOT change within Core v1"), or an error-severity finding from
 *   `evaluateTransitionBoundary` -- `transition-validation.ts`'s own shared,
 *   graph-wide before/after transition core -- run over ANY adjacent pair of
 *   consumed authoritative boundaries (twelfth-round review Finding 1): an
 *   illegal lifecycle transition or illegal first authoritative appearance
 *   for ANY id (not only `targetId`), an issued Artifact ID physically
 *   disappearing (02-identity.md permanent retention), frozen whole-Artifact
 *   or Resource mutation, supersession atomicity or implicit-retargeting
 *   violations, or CHG net-effect classification, exactly-once coverage, or
 *   truthfulness violations for EVERY target in that commit -- not only the
 *   one this query asked about. This maps to `EF-QRY-013` ("Query cannot
 *   produce a complete trustworthy result", diagnostic-registry.md).
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
	// Twelfth-round review Finding 1: the PREVIOUS consumed authoritative
	// boundary's own validated snapshot + per-path blob OID index -- paired
	// with the CURRENT commit's own equivalent below and handed to the
	// shared, graph-wide `evaluateTransitionBoundary` core every iteration
	// from the second consumed commit onward. This one pairing subsumes every
	// tenth/eleventh-round hand-maintained, TARGET-SCOPED cross-commit check
	// this walk used to re-derive on its own (issued-ID permanent retention,
	// CHG lifecycle transition legality and terminal-aggregate freeze, the
	// target's own lifecycle-transition legality, and CHG net-effect
	// truthfulness/coverage/exactly-once claims) -- all of those are
	// graph-wide invariants the shared core already proves for EVERY id in
	// the commit, not only `targetId`. `undefined` only for the bootstrap
	// commit itself (09-validation.md's bootstrap exception has no "before"
	// side; no synthetic baseline is invented for it).
	let previousBoundarySide: TransitionBoundarySide | undefined
	// The previous iteration's own commit OID, passed through to
	// `evaluateTransitionBoundary` purely as informational provenance (it is
	// never consulted by that function's own comparison logic).
	let previousOid: string | undefined

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
	// `previousTreeMap`/`previousEnvelope`/`previousBoundarySide`/
	// `previousOid` are left at their initial (empty/undefined) values through
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

		// ---- Aggregate diffing: did this commit change the target's owned paths? ----
		// (Requested-target projection: which commits/paths belong to
		// `targetId`'s own aggregate. Not a graph-wide invariant, so not
		// something the shared transition core below could ever compute.)
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

		// ---- Twelfth-round review Finding 1: the shared, graph-wide transition core ----
		// `previousBoundarySide` is `undefined` only for the bootstrap commit
		// itself (no synthetic "before" side is invented for it -- bootstrap's
		// own state rules were already validated above/in
		// `evaluateBootstrapBoundary`). From the second consumed commit
		// onward, this pairs the PREVIOUS consumed boundary against the
		// CURRENT one and runs them through the EXACT SAME
		// `evaluateTransitionBoundary` core `transition-validation.ts` uses for
		// baseline/proposed commits: lifecycle transition legality and
		// prohibited first appearance for EVERY id (not only `targetId`),
		// issued-ID physical-deletion/type/path immutability, frozen
		// whole-Artifact and Resource preservation, supersession atomicity and
		// implicit retargeting, and CHG net-effect classification,
		// exactly-once coverage, and truthfulness for EVERY target in the
		// commit. Any error-severity diagnostic here means a real commit-time
		// transaction validator would have rejected this exact boundary, so
		// the whole query is untrustworthy -- regardless of whether the
		// violation concerns `targetId` at all (the reviewer's exact
		// scenario: a truthful effect on the queried target in the SAME
		// transaction as a false effect on an unrelated one).
		const currentBoundarySide: TransitionBoundarySide = {
			snapshot: commitValidation.snapshot,
			validation: commitValidation.validation,
			oidByPath: oidByPathFrom(treeMap),
		}

		if (previousBoundarySide) {
			const transitionDiagnostics = evaluateTransitionBoundary({
				before: previousBoundarySide,
				after: currentBoundarySide,
				beforeOid: previousOid,
				afterOid: oid,
			})
			if (hasErrorDiagnostic(transitionDiagnostics))
				return { kind: 'untrusted-data' }

			// ---- Effect-record extraction (requested-target projection) ----
			// The shared core above already PROVES, graph-wide, that: at most
			// one completing CHG claims `targetId` in this commit
			// (EF-CHG-007), any completing CHG's declared effect type
			// truthfully matches its target's actual net effect
			// (EF-CHG-003/006/012), and CHG-required coverage holds
			// (EF-CHG-005) -- so this loop only IDENTIFIES which
			// already-validated completing CHG's effect (if any) belongs to
			// `targetId`, and projects its already-proven-true fields. It
			// never re-derives or re-checks truthfulness/coverage/exclusivity
			// itself; that would just be re-doing what the core above already
			// proved.
			for (const record of currentBoundarySide.validation.byId.values()) {
				if (record.type !== 'change')
					continue
				const beforeStatus = previousBoundarySide.validation.byId.get(record.id)?.status
				if (record.status !== 'completed' || beforeStatus === 'completed')
					continue // not a NEWLY completing CHG in this commit.

				const effectRelation = record.relations.find(
					(relation): relation is typeof relation & { type: 'introduces' | 'modifies' | 'retires' } =>
						relation.target === targetId
						&& (relation.type === 'introduces' || relation.type === 'modifies' || relation.type === 'retires'),
				)
				if (!effectRelation)
					continue

				// History is defined by the authoritative integration state
				// observed AT THIS COMMIT, not by whatever the CHG's current
				// (possibly since-edited, possibly uncommitted) record says
				// now -- the effect summary is built unconditionally from the
				// historically-decoded envelope/path at this `oid`.
				const chgSummary = buildArtifactSummary(record.envelope, record.path)
				effects.push({
					chg: chgSummary,
					effect: effectRelation.type,
					status_before: previousEnvelope?.status ?? null,
					status_after: currentEnvelope?.status ?? previousEnvelope?.status ?? 'retired',
					commit_oid: oid,
				})
			}
		}

		previousTreeMap = treeMap
		previousEnvelope = currentEnvelope
		previousBoundarySide = currentBoundarySide
		previousOid = oid
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

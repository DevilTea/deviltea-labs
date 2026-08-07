/**
 * `ef artifact create <type>` plan/apply (13-cli-contract.md "Draft Artifact
 * Creation", "Filesystem Write Safety" / "Draft Artifact hard-link
 * publication"; 02-identity.md Allocation; 08-artifact-schemas.md required
 * H2 skeletons per type).
 *
 * `computeCreatePlan` is pure: it maps a CLI type token to an `ArtifactType`
 * (PROJECT is never a valid token here), refuses (`allocation-incomplete`)
 * when any canonical-directory file for that prefix lacks a decodable,
 * identity-certain envelope -- an undecoded file, an `EF-ID-001`/`EF-ID-003`
 * class identity finding, or an identity-relevant duplicate-key loss all make
 * the true greatest visible component unknowable, and 02-identity.md
 * Allocation requires allocation to stay incomplete rather than guess past
 * it -- allocates the next provisional ID over the already-loaded
 * `ProjectSnapshot`'s visible graph via `domain/identity.ts`'s `nextId`,
 * builds the complete draft file bytes (all nine core envelope fields, empty
 * `tags`/`relations`/`resources`, and the type's required H2 headings with
 * empty content), and self-validates the result through the non-graph-dependent
 * domain validators (identity syntax, filename, status, body schema) before
 * ever proposing it for publication.
 *
 * `applyCreatePlan` performs the exact hard-link publication protocol: verify,
 * from its very first checkpoint, that `.engineering` itself still denotes
 * exactly the directory `computeCreatePlan`'s caller observed at discovery
 * time (`ArtifactCreatePlan.engineeringIdentity`, threaded from
 * `loadWorkingTreeContext` -- Finding 2, tenth round; `.engineering` is never
 * created or silently re-accepted-as-new by this command, unlike the type
 * directory, which legitimately may not exist yet), write the complete file
 * at a temporary same-directory path, validate the written bytes, bind an
 * identity to the verified temporary file, re-verify the managed directory
 * chain and that the target is still absent, publish via a
 * create-if-absent hard link (treating target-exists as a race rather than a
 * replacement), re-verify the chain AND the published path's own identity
 * immediately afterward (attempting an ownership-proven retraction on
 * mismatch rather than ever misreporting either state -- see
 * `ApplyCreatePlanResult`'s `applied: true, outcome: 'incomplete'` variant),
 * and unlink the temporary name -- a failure of that final, otherwise
 * best-effort cleanup step is itself reported as its own typed
 * `applied: true, outcome: 'cleanup-failed'` variant rather than silently
 * folded into a plain success (13-cli-contract.md "the implementation MUST
 * NOT misreport the published state as unapplied" -- a verified publication
 * followed only by a failed cleanup step is exactly the "publication
 * succeeds but a later cleanup or internal operation fails" case that
 * provision describes). Every `lstat`-based re-verification here is
 * the strongest available mitigation, not a claim of race-freedom: Node
 * exposes no `openat`-style, file-descriptor-relative primitive on any
 * platform this package targets, so a swap that lands strictly inside the
 * narrow window between one check and the single syscall it guards cannot be
 * closed in-process (00's "path handling is not a filesystem-security
 * boundary"; the EF threat model treats the working tree as the operator's
 * own data, not adversarial input). See `verifyManagedDirectoryChain`'s own
 * documentation for the precise boundary of what these checks do and do not
 * catch.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, Envelope } from '../domain/model'
import type { FileIdentity } from '../platform/fs-facts'
import type { SymlinkFact } from '../repository/symlinks'
import type { LoadSnapshotResult, ProjectSnapshot, SnapshotArtifactFile } from './snapshot'
import { mkdir as fsMkdir, unlink as fsUnlink, lstat } from 'node:fs/promises'
import path from 'pathe'
import { validateBody } from '../domain/body-schemas'
import { decodeEnvelope } from '../domain/envelope'
import { nextId as domainNextId, validateFilename, validateIdSyntax } from '../domain/identity'
import { validateStatus } from '../domain/lifecycle'
import { CANONICAL_DIR_BY_TYPE, ID_PREFIX_BY_TYPE, SCHEMA_BY_TYPE } from '../domain/model'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { extractSections, parseBody } from '../parsing/markdown'
import { directoryIdentity, isDirectory, isRegularFile, isSymlink, readFileBytes, sameFileIdentity } from '../platform/fs-facts'
import { publishViaHardLink, writeTempFileComplete } from '../platform/hard-link-publish'
import { generateNonce } from '../platform/nonce'
import { checkManagedSymlinks } from '../repository/symlinks'
import { loadSnapshotFromWorkingTree } from './snapshot'

// ---------------------------------------------------------------------------
// Type tokens and required skeleton headings (13-cli-contract.md, 08-artifact-schemas.md)
// ---------------------------------------------------------------------------

export type ArtifactCreateTypeToken = 'prd' | 'req' | 'adr' | 'pol' | 'chg'

const TYPE_TOKEN_MAP: Record<ArtifactCreateTypeToken, Exclude<ArtifactType, 'project'>> = {
	prd: 'prd',
	req: 'requirement',
	adr: 'decision',
	pol: 'policy',
	chg: 'change',
}

/**
 * Required H2 skeleton per type, in order. Duplicated locally rather than
 * imported from `domain/body-schemas.ts` (whose equivalent table is
 * module-private): the draft plan self-validates via `validateBody`, which
 * would surface `EF-BODY-001` if this table ever drifted from that module's
 * own required-heading rules.
 */
const REQUIRED_HEADINGS: Record<ArtifactCreateTypeToken, readonly string[]> = {
	prd: ['Problem', 'User Need', 'Desired Outcome', 'Success Criteria', 'Non-goals'],
	req: ['Requirement', 'Rationale', 'Acceptance Criteria'],
	adr: ['Context', 'Decision', 'Alternatives', 'Consequences'],
	pol: ['Policy', 'Scope', 'Rationale', 'Compliance'],
	chg: ['Rationale', 'Sources', 'Changes', 'Verification'],
}

function isCreateTypeToken(value: string): value is ArtifactCreateTypeToken {
	return Object.hasOwn(TYPE_TOKEN_MAP, value)
}

// ---------------------------------------------------------------------------
// computeCreatePlan
// ---------------------------------------------------------------------------

export interface ComputeCreatePlanInput {
	snapshot: ProjectSnapshot
	/** Raw CLI type token; validated here (`project` and any unknown token are rejected). */
	type: string
	title: string
	summary: string
	/**
	 * `.engineering`'s identity as already observed by discovery (`cli/project-context.ts`'s
	 * `ProjectContext.engineeringIdentity`, threaded here via
	 * `cli/working-tree-context.ts`'s `WorkingTreeContext.engineeringIdentity`;
	 * Finding 2, tenth round). Carried onto the resulting {@link ArtifactCreatePlan}
	 * unchanged so `applyCreatePlan` can bind its OWN, separate, later
	 * `.engineering` re-verifications back to the exact directory this plan was
	 * computed against, rather than accepting whatever merely happens to exist
	 * (or does not exist) at apply time -- see `applyCreatePlan`'s own doc.
	 */
	engineeringIdentity: FileIdentity
}

export interface ArtifactCreatePlan {
	type: Exclude<ArtifactType, 'project'>
	id: string
	/** Project-relative canonical path, `/` separators. */
	path: string
	bytes: Uint8Array
	envelope: Envelope
	changes: [{ action: 'create', path: string }]
	/** See {@link ComputeCreatePlanInput.engineeringIdentity}. */
	engineeringIdentity: FileIdentity
}

export type ComputeCreatePlanFailureReason
	= | 'invalid-type'
		| 'missing-value'
		| 'target-exists'
		| 'invalid-plan'
		| 'managed-directory-symlinked'
		| 'allocation-incomplete'

export type ComputeCreatePlanResult
	= | { ok: true, plan: ArtifactCreatePlan }
		| { ok: false, reason: ComputeCreatePlanFailureReason, message: string, diagnostics?: Diagnostic[] }

function yamlDoubleQuoted(value: string): string {
	return JSON.stringify(value)
}

function buildDraftArtifactText(envelope: Envelope, headings: readonly string[]): string {
	const frontmatter = [
		'---',
		`schema: ${envelope.schema}`,
		`type: ${envelope.type}`,
		`id: ${envelope.id}`,
		`title: ${yamlDoubleQuoted(envelope.title)}`,
		`status: ${envelope.status}`,
		`summary: ${yamlDoubleQuoted(envelope.summary)}`,
		'tags: []',
		'relations: []',
		'resources: []',
		'---',
		'',
	].join('\n')

	const body = headings.map(name => `## ${name}\n`)
		.join('\n')

	return frontmatter + body
}

/**
 * `EF-FS-004` findings (11-filesystem-and-config.md symlink policy: "Symlinks
 * are forbidden for `.engineering` and its canonical directories") for the
 * two managed directories a new draft's canonical path descends through --
 * `.engineering` itself and the type's canonical directory. Reuses
 * `repository/symlinks.ts`'s own `checkManagedSymlinks` rather than
 * reimplementing the forbidden-symlink diagnostic; only the already-loaded
 * `snapshot.entryKinds` is consulted, keeping `computeCreatePlan` pure.
 */
function managedDirectoryChainDiagnostics(snapshot: ProjectSnapshot, artifactType: Exclude<ArtifactType, 'project'>): Diagnostic[] {
	const chainPaths = ['.engineering', CANONICAL_DIR_BY_TYPE[artifactType]]
	const facts: SymlinkFact[] = chainPaths.map(p => ({ path: p, isSymlink: snapshot.entryKinds.get(p) === 'symlink' }))
	return checkManagedSymlinks(facts)
}

/** Every Artifact ID visible in `snapshot` whose envelope decoded successfully (02-identity.md "every ... provisional Artifact visible in the working graph"). */
function collectVisibleIds(snapshot: ProjectSnapshot): string[] {
	const ids: string[] = []
	for (const artifact of snapshot.artifacts) {
		const id = artifact.envelope?.envelope?.id
		if (id !== undefined)
			ids.push(id)
	}
	return ids
}

/**
 * `true` iff `artifact`'s declared Artifact ID is exactly and unambiguously
 * known: the frontmatter parsed, the envelope decoded to completion, the
 * `id` field itself was not lost to a duplicate top-level key
 * (`EF-ENV-005`), and the declared ID's lexical shape and canonical numeric
 * form are both valid (`EF-ID-001`, `EF-ID-003`). A `false` result means
 * this file's true numeric component cannot be established -- it might be
 * hiding the actual greatest visible component for its prefix -- so
 * allocation cannot rule out a higher reservation by silently skipping it
 * (02-identity.md Allocation: "If it cannot process the greatest visible
 * component exactly, allocation is incomplete and does not issue an ID").
 */
function hasIdentityCertainEnvelope(artifact: SnapshotArtifactFile): boolean {
	const decoded = artifact.envelope?.envelope
	if (decoded === undefined || decoded === null)
		return false
	if (artifact.document?.diagnostics.some(d => d.code === 'EF-ENV-005' && d.field === 'id'))
		return false
	const idDiagnostics = validateIdSyntax({ type: decoded.type, id: decoded.id }, artifact.path)
	return !idDiagnostics.some(d => d.code === 'EF-ID-001' || d.code === 'EF-ID-003')
}

/**
 * The first Artifact file ANYWHERE in the full discovery scope (`02-identity.md`
 * Allocation: "every ... provisional Artifact visible in the working graph")
 * whose envelope is not identity-certain (see {@link hasIdentityCertainEnvelope}),
 * or `undefined` when every discovered file's contribution to the greatest
 * visible numeric component is exactly known.
 *
 * NOT scoped to the requested prefix's canonical directory (Finding 4): a
 * file's directory placement alone can never prove its declared type or ID.
 * A file whose envelope failed to decode -- or whose declared `id` could not
 * be established -- is identity-uncertain regardless of which canonical
 * directory it physically sits in; `.engineering/adr/junk.md` might, once
 * decoded, have actually declared `id: REQ-999` in a wrong-directory
 * placement, and restricting the scan to `.engineering/req` would let a
 * `req` allocation select a candidate without ever knowing the true greatest
 * visible REQ component. A file whose envelope DID decode to completion,
 * declaring a KNOWN, different type, remains safely ignorable regardless of
 * its directory: its true prefix is exactly known and does not match.
 */
function findIdentityUncertainArtifact(snapshot: ProjectSnapshot): SnapshotArtifactFile | undefined {
	return snapshot.artifacts.find(artifact => !hasIdentityCertainEnvelope(artifact))
}

/** Structural self-validation of freshly built draft bytes: parsing, envelope decoding, identity syntax, filename, status, and body schema. Does not require the full project graph. */
function validateDraftArtifactBytes(bytes: Uint8Array, filePath: string): Diagnostic[] {
	const text = new TextDecoder('utf-8', { fatal: false })
		.decode(bytes)
	const frontmatter = splitFrontmatter(text)
	if (!frontmatter.ok)
		return [{ ...frontmatter.diagnostic, path: filePath }]

	const document = parseFrontmatterDocument(frontmatter.frontmatterText, filePath, { startLine: 2 })
	const envelopeResult = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, filePath)
	const body = parseBody(frontmatter.bodyText, frontmatter.bodyStartLine - 1)

	const diagnostics: Diagnostic[] = [...document.diagnostics, ...envelopeResult.diagnostics]
	if (!body.ok) {
		diagnostics.push({ ...body.diagnostic, path: filePath })
		return diagnostics
	}

	const envelope = envelopeResult.envelope
	if (!envelope)
		return diagnostics

	diagnostics.push(...validateIdSyntax({ type: envelope.type, id: envelope.id }, filePath))
	diagnostics.push(...validateFilename({ type: envelope.type, id: envelope.id }, filePath))
	diagnostics.push(...validateStatus({ type: envelope.type, status: envelope.status, id: envelope.id }, filePath))
	diagnostics.push(...validateBody({ type: envelope.type, status: envelope.status, path: filePath, body: extractSections(body.root) }))

	return diagnostics
}

/**
 * Compute the complete draft Artifact creation plan over an already-loaded
 * `snapshot`. Pure; performs no filesystem access.
 */
export function computeCreatePlan(input: ComputeCreatePlanInput): ComputeCreatePlanResult {
	const { snapshot, type, title, summary, engineeringIdentity } = input

	if (!isCreateTypeToken(type)) {
		return {
			ok: false,
			reason: 'invalid-type',
			message: type === 'project'
				? 'PROJECT is created only by \'ef init\', not \'ef artifact create\'.'
				: `Unsupported artifact type token '${type}'; expected one of: prd, req, adr, pol, chg.`,
		}
	}

	if (title.trim().length === 0)
		return { ok: false, reason: 'missing-value', message: '\'title\' must be a non-empty value.' }
	if (/[\r\n]/.test(title.trim()))
		return { ok: false, reason: 'missing-value', message: '\'title\' must be a single line.' }
	if (summary.trim().length === 0)
		return { ok: false, reason: 'missing-value', message: '\'summary\' must be a non-empty value.' }

	const artifactType = TYPE_TOKEN_MAP[type]
	const prefix = ID_PREFIX_BY_TYPE[artifactType]
	const canonicalDir = CANONICAL_DIR_BY_TYPE[artifactType]

	// The allocator contract requires inspecting every visible Artifact
	// before selecting a candidate (02-identity.md Allocation). An
	// identity-uncertain file's greatest visible component is not actually
	// known -- and, per Finding 4, its directory placement alone can never
	// prove it is NOT this prefix -- so it must never be silently treated as
	// absent, regardless of which canonical directory it physically sits in.
	const uncertainArtifact = findIdentityUncertainArtifact(snapshot)
	if (uncertainArtifact) {
		return {
			ok: false,
			reason: 'allocation-incomplete',
			message: `Cannot allocate the next '${prefix}' ID: '${uncertainArtifact.path}' does not have a decodable, identity-certain envelope, so the greatest visible '${prefix}' component is not known.`,
		}
	}

	const id = domainNextId(prefix, collectVisibleIds(snapshot))
	const filePath = `${canonicalDir}/${id}.md`

	const chainDiagnostics = managedDirectoryChainDiagnostics(snapshot, artifactType)
	if (chainDiagnostics.length > 0) {
		return {
			ok: false,
			reason: 'managed-directory-symlinked',
			message: `The managed directory chain for '${filePath}' contains a forbidden symlink.`,
			diagnostics: chainDiagnostics,
		}
	}

	if (snapshot.entryKinds.has(filePath))
		return { ok: false, reason: 'target-exists', message: `'${filePath}' already exists.` }

	const envelope: Envelope = {
		schema: SCHEMA_BY_TYPE[artifactType],
		type: artifactType,
		id,
		title: title.trim(),
		status: 'draft',
		summary: summary.trim(),
		tags: [],
		relations: [],
		resources: [],
		extensions: {},
	}

	const bytes = new TextEncoder()
		.encode(buildDraftArtifactText(envelope, REQUIRED_HEADINGS[type]))

	const selfCheck = validateDraftArtifactBytes(bytes, filePath)
	const selfCheckErrors = selfCheck.filter(d => d.severity === 'error')
	if (selfCheckErrors.length > 0) {
		return {
			ok: false,
			reason: 'invalid-plan',
			message: `The computed draft plan for '${id}' failed self-validation.`,
			diagnostics: selfCheck,
		}
	}

	return {
		ok: true,
		plan: {
			type: artifactType,
			id,
			path: filePath,
			bytes,
			envelope,
			changes: [{ action: 'create', path: filePath }],
			engineeringIdentity,
		},
	}
}

// ---------------------------------------------------------------------------
// applyCreatePlan
// ---------------------------------------------------------------------------

export interface ApplyCreatePlanDeps {
	writeTempFileComplete: typeof writeTempFileComplete
	publishViaHardLink: typeof publishViaHardLink
	unlink: (path: string) => Promise<void>
	isRegularFile: (path: string) => Promise<boolean>
	isDirectory: (path: string) => Promise<boolean>
	isSymlink: (path: string) => Promise<boolean>
	readFileBytes: (path: string) => Promise<Uint8Array>
	generateNonce: () => string
	/** Ensure the canonical type directory exists (11-filesystem-and-config.md: "Tools create it when needed" for a directory Git did not preserve). */
	ensureDirectory: (path: string) => Promise<void>
	/** `lstat`-derived identity of `path` iff it is right now a real, non-symlink directory; `undefined` otherwise. Used to bind successive managed-directory-chain re-verifications together (see `verifyManagedDirectoryChain`). */
	directoryIdentity: (path: string) => Promise<FileIdentity | undefined>
	/**
	 * `lstat`-derived identity of `path` iff it is right now a real, non-symlink
	 * regular file; `undefined` otherwise (missing, a symlink, a directory, or
	 * any other entry kind). Used to bind the complete, verified temporary
	 * file to whatever the canonical target denotes immediately after
	 * publication (see the post-write and post-publication verification in
	 * `applyCreatePlan`), the same way `directoryIdentity` binds successive
	 * managed-directory-chain checkpoints.
	 */
	fileIdentity: (path: string) => Promise<FileIdentity | undefined>
	/**
	 * A fresh, bounded re-enumeration of the full Artifact discovery scope
	 * (Finding 2, ninth round) -- never the possibly-stale `snapshot`
	 * `computeCreatePlan` was originally computed from. Used immediately
	 * before publication to re-run the identical identity/allocation witness
	 * that computed the plan in the first place (see
	 * `verifyAllocationStillValid`), so a competing writer that made a higher
	 * same-prefix Artifact (or an identity-uncertain file) visible strictly
	 * between plan computation and this call is caught even though it never
	 * touches the plan's own candidate `targetPath` at all.
	 *
	 * `expectedEngineeringIdentity` is threaded straight through to
	 * `loadSnapshotFromWorkingTree`'s own option of the same name (Finding 2,
	 * tenth round): the re-enumeration itself must be bound to the exact
	 * `.engineering` this plan was computed against, not merely whatever
	 * directory happens to occupy that path when this call runs -- otherwise
	 * a `.engineering` swapped for a different (e.g. emptied or
	 * differently-populated) real directory strictly around this call could
	 * silently re-derive allocation from the WRONG project's graph instead of
	 * failing closed.
	 */
	loadSnapshot: (projectRoot: string, expectedEngineeringIdentity: FileIdentity) => Promise<LoadSnapshotResult>
}

async function defaultFileIdentity(target: string): Promise<FileIdentity | undefined> {
	try {
		const stats = await lstat(target)
		return stats.isFile() ? { dev: stats.dev, ino: stats.ino } : undefined
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return undefined
		throw error
	}
}

/** Real filesystem access, composed from `platform/*` primitives. */
export const defaultApplyCreatePlanDeps: ApplyCreatePlanDeps = {
	writeTempFileComplete,
	publishViaHardLink,
	unlink: async (target) => {
		await fsUnlink(target)
	},
	isRegularFile,
	isDirectory,
	isSymlink,
	readFileBytes,
	generateNonce,
	ensureDirectory: async (target) => {
		await fsMkdir(target, { recursive: true })
	},
	directoryIdentity,
	fileIdentity: defaultFileIdentity,
	loadSnapshot: (projectRoot, expectedEngineeringIdentity) => loadSnapshotFromWorkingTree(projectRoot, undefined, { expectedEngineeringIdentity }),
}

export type ApplyCreatePlanResult
	= | { applied: true, outcome: 'applied', path: string }
		/**
		 * The hard-link publication call itself reported success, but an
		 * immediate post-publication re-verification (managed directory chain
		 * identity AND the published path's own `fstat` identity bound back to
		 * the temporary file that was published) no longer matched, and the
		 * mismatch could not be safely undone: the entry now at `path` could not
		 * be proven -- by inode identity -- to be the exact file this invocation
		 * wrote, so unlinking it would risk deleting state this invocation never
		 * created (the same ownership-proof rule Finding 1 applies to
		 * `.engineering` itself). `applied: true` because the publish call
		 * itself did succeed; `outcome: 'incomplete'` because its result could
		 * not be verified afterward and must not be misreported as a plain,
		 * fully-verified success. See `13-cli-contract.md`'s "recovery is an
		 * explicit operator action".
		 */
		| { applied: true, outcome: 'incomplete', path: string, message: string }
		/**
		 * Publication succeeded AND every post-publication verification (managed
		 * chain identity, published-path identity bound back to the temporary
		 * file) confirmed the published file is exactly what this invocation
		 * wrote -- but the best-effort removal of the now-superfluous temporary
		 * file itself failed. The publication is genuinely complete and MUST NOT
		 * be misreported as unapplied (13-cli-contract.md "the implementation
		 * MUST NOT misreport the published state as unapplied"); distinct from
		 * the `outcome: 'incomplete'` variant above, which reports an UNVERIFIED
		 * publication, not a verified one with a merely-failed cleanup step. Both
		 * are `applied: true` with a non-`'applied'` outcome, so a caller that
		 * maps every such state to the same "publication succeeded but a later
		 * cleanup or internal operation failed" contract need not distinguish
		 * them further.
		 */
		| { applied: true, outcome: 'cleanup-failed', path: string, message: string }
		| { applied: false, outcome: 'raced', message: string }
		| { applied: false, outcome: 'unsupported', message: string }
		| { applied: false, outcome: 'incomplete', message: string }
		| { applied: false, outcome: 'rejected', message: string }

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length)
		return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i])
			return false
	}
	return true
}

async function targetExists(deps: ApplyCreatePlanDeps, targetPath: string): Promise<boolean> {
	return (await deps.isRegularFile(targetPath)) || (await deps.isDirectory(targetPath)) || (await deps.isSymlink(targetPath))
}

/** `lstat` identity of `.engineering` and, when distinct, the type's canonical directory, captured by one `verifyManagedDirectoryChain` call for a later call to bind against. The type directory may not exist yet (before `ensureDirectory` creates it), so it has no identity to capture until it does. */
export interface ManagedDirectoryChainIdentity {
	engineering?: FileIdentity
	typeDir?: FileIdentity
}

export type VerifyManagedDirectoryChainResult
	= | { ok: true, identity: ManagedDirectoryChainIdentity }
		| { ok: false }

/**
 * Re-verify one component of the managed directory chain: it must not be a
 * symlink (as before), AND, if `previousIdentity` is supplied (a prior
 * capture from an earlier checkpoint in this same `applyCreatePlan`
 * invocation -- for `.engineering`, this is `plan.engineeringIdentity` from
 * the very FIRST checkpoint onward, never `undefined`; Finding 2, tenth
 * round), it must still be a real directory with that IDENTICAL `dev`/`ino`
 * identity. A component with no `previousIdentity` yet (only ever the type
 * directory at its first checkpoint, or a component that did not exist as a
 * directory at the previous checkpoint) is not rejected merely for currently
 * being absent or not-yet-a-directory -- that is the ordinary, legitimate
 * "not created yet" case `ensureDirectory` handles. `.engineering` itself
 * never receives that tolerance: it must already exist as exactly the
 * directory discovery observed.
 */
async function verifyChainComponent(deps: ApplyCreatePlanDeps, componentPath: string, previousIdentity: FileIdentity | undefined): Promise<{ ok: true, identity: FileIdentity | undefined } | { ok: false }> {
	if (await deps.isSymlink(componentPath))
		return { ok: false }
	const identity = await deps.directoryIdentity(componentPath)
	if (previousIdentity !== undefined && (identity === undefined || !sameFileIdentity(identity, previousIdentity)))
		return { ok: false }
	return { ok: true, identity }
}

/**
 * Live, uncached re-verification of the two-component managed chain
 * (`.engineering`, the type's canonical directory) that
 * `managedDirectoryChainDiagnostics` checks from the snapshot at plan time --
 * re-checked against the real filesystem immediately before the temporary
 * write, again immediately before hard-link publication, and once more
 * immediately after publication succeeds (13-cli-contract.md "verify again
 * that allocation and the canonical target remain valid"). A snapshot taken
 * at plan time cannot detect a chain component replaced afterward; only a
 * fresh `lstat` at each checkpoint can.
 *
 * Exact guarantee (same portability/security-boundary narrowing as
 * `application/init.ts`'s `applyInitPlan`; Node exposes no `openat`-style,
 * file-descriptor-relative primitive on any platform this package targets,
 * so this is not a claim of race-freedom -- see 00's "path handling is not a
 * filesystem-security boundary" and the EF threat model, in which the
 * working tree is the operator's own data):
 *
 * - A component swapped for a *different real directory* (no symlink ever
 *   involved), or swapped out to a symlink and back to a different real
 *   directory, strictly BETWEEN two checkpoints is caught: threading
 *   `previous` through successive calls means each checkpoint after the
 *   first also compares identity against what the immediately preceding
 *   checkpoint captured, not merely a fresh, independent `isSymlink` check
 *   (which alone would report "false" at every individual checkpoint even
 *   though the chain never denoted the SAME directory the whole time).
 * - A swap that lands strictly INSIDE the narrow window between one
 *   checkpoint and the single operation it guards is NOT caught by this
 *   function alone -- that operation is still pathname-based. `applyCreatePlan`
 *   additionally binds the write itself to a captured file identity and,
 *   after publication, re-verifies both the chain and the published path's
 *   own identity, attempting an ownership-proven retraction on mismatch
 *   rather than ever reporting an unverified state as a plain success.
 * - The narrowest residual case -- a component swapped out and fully
 *   restored to the exact SAME directory instance strictly between one
 *   checkpoint and the operation it guards -- still acts on the genuine,
 *   previously verified directory either way; the only possible outcome
 *   there is a spurious rejection of an otherwise-legitimate run.
 */
async function verifyManagedDirectoryChain(deps: ApplyCreatePlanDeps, projectRoot: string, targetPath: string, previous: ManagedDirectoryChainIdentity | undefined): Promise<VerifyManagedDirectoryChainResult> {
	const engineeringPath = path.join(projectRoot, '.engineering')
	const typeDirPath = path.dirname(targetPath)

	const engineeringResult = await verifyChainComponent(deps, engineeringPath, previous?.engineering)
	if (!engineeringResult.ok)
		return { ok: false }

	if (typeDirPath === engineeringPath)
		return { ok: true, identity: { engineering: engineeringResult.identity } }

	const typeDirResult = await verifyChainComponent(deps, typeDirPath, previous?.typeDir)
	if (!typeDirResult.ok)
		return { ok: false }

	return { ok: true, identity: { engineering: engineeringResult.identity, typeDir: typeDirResult.identity } }
}

/**
 * Best-effort removal of the temporary file, reporting whether it actually
 * succeeded. Most call sites intentionally ignore the return value: the
 * outcome they already report does not depend on it (13-cli-contract.md's
 * eight-step protocol only requires the CANONICAL publication or the
 * pre-publication cleanup to be correct; a leftover uniquely-nonced temp file
 * from an already-failed or already-rejected attempt is not itself a
 * completeness failure). The one call site that DOES depend on it is the
 * verified-publish success path in `applyCreatePlan` (Finding 2): once
 * publication is confirmed byte-for-byte and identity-for-identity, cleanup
 * failing there must be surfaced as its own typed, non-silently-swallowed
 * outcome rather than folded into a plain, unqualified success.
 */
async function safeUnlink(deps: ApplyCreatePlanDeps, tempPath: string): Promise<boolean> {
	try {
		await deps.unlink(tempPath)
		return true
	}
	catch {
		return false
	}
}

export type VerifyAllocationStillValidResult
	= | { ok: true }
		| { ok: false, message: string }

/**
 * Re-establish, immediately before publication, that `plan`'s requested
 * prefix's allocation is still exactly what `computeCreatePlan` computed it
 * to be (Finding 2, ninth round; 13-cli-contract.md "verify again that
 * allocation and the canonical target remain valid"; 02-identity.md
 * Allocation: the next ID must be exactly max(visible same-prefix
 * component) + 1).
 *
 * The pre-publication `targetExists` re-check alone proves only that THIS
 * invocation's own candidate ID is still unclaimed at its own canonical
 * path -- it proves nothing about whether some OTHER writer made a HIGHER
 * same-prefix Artifact visible (at a DIFFERENT path) between plan
 * computation and this call. Concretely: the plan selected `REQ-002`;
 * before this call runs, another writer publishes a valid `REQ-999`. Every
 * `targetExists` check against `REQ-002.md` keeps passing (that exact path
 * was never touched), yet the true required next allocation is now
 * `REQ-1000`, not `REQ-002` -- publishing `REQ-002` anyway would violate
 * 02-identity.md's max(visible)+1 rule.
 *
 * Re-enumerates the FULL discovery scope fresh via `deps.loadSnapshot`
 * (never the `snapshot` `plan` was originally computed from, which can only
 * grow staler the longer `applyCreatePlan` runs) and re-runs the identical
 * witness `computeCreatePlan` used: the identity-uncertainty scan
 * (`findIdentityUncertainArtifact`) must still be clean, and `nextId` over
 * every now-visible same-prefix ID must still equal `plan.id` exactly. A
 * failure of either check, or of the re-enumeration itself, is reported as
 * a rejection -- the caller treats this the same as any other typed race.
 *
 * The re-enumeration is bound to `plan.engineeringIdentity` (Finding 2,
 * tenth round): `deps.loadSnapshot` fails closed (`engineering-swapped`)
 * rather than silently re-deriving allocation from a DIFFERENT `.engineering`
 * substituted at the same path since the plan was computed.
 */
async function verifyAllocationStillValid(deps: ApplyCreatePlanDeps, projectRoot: string, plan: ArtifactCreatePlan): Promise<VerifyAllocationStillValidResult> {
	const reloaded = await deps.loadSnapshot(projectRoot, plan.engineeringIdentity)
	if (!reloaded.ok) {
		return { ok: false, message: `The allocation for '${plan.path}' could not be re-verified immediately before publication: ${reloaded.message}` }
	}

	const snapshot = reloaded.snapshot
	const prefix = ID_PREFIX_BY_TYPE[plan.type]

	const uncertainArtifact = findIdentityUncertainArtifact(snapshot)
	if (uncertainArtifact) {
		return { ok: false, message: `Cannot publish '${plan.path}': '${uncertainArtifact.path}' does not have a decodable, identity-certain envelope, so the greatest visible '${prefix}' component is no longer known.` }
	}

	const currentNextId = domainNextId(prefix, collectVisibleIds(snapshot))
	if (currentNextId !== plan.id) {
		return { ok: false, message: `The next '${prefix}' allocation changed from '${plan.id}' to '${currentNextId}' immediately before publication; another writer made a higher '${prefix}' Artifact visible.` }
	}

	return { ok: true }
}

/**
 * Perform the exact 13-cli-contract.md "Draft Artifact hard-link
 * publication" protocol for an already-computed `plan`. `projectRoot` is the
 * absolute project root the plan's project-relative paths are resolved
 * against.
 */
export async function applyCreatePlan(plan: ArtifactCreatePlan, projectRoot: string, deps: ApplyCreatePlanDeps = defaultApplyCreatePlanDeps): Promise<ApplyCreatePlanResult> {
	const targetPath = path.join(projectRoot, plan.path)

	if (await targetExists(deps, targetPath))
		return { applied: false, outcome: 'raced', message: `'${plan.path}' already exists.` }

	// Re-verify before ever touching the filesystem below `.engineering`:
	// `ensureDirectory` (a recursive `mkdir`) follows symlinks, so checking
	// only after it ran would be too late whenever `.engineering` itself is a
	// symlink and the type directory does not yet exist beneath its target --
	// `mkdir -p` would silently create it outside the project first.
	//
	// `.engineering` itself is bound to `plan.engineeringIdentity` from this
	// very first checkpoint (Finding 2, tenth round), never merely
	// `undefined`: unlike the type directory (legitimately absent when no
	// Artifact of that type has been created yet -- Git does not preserve
	// empty directories), `.engineering` MUST already exist as the exact
	// directory discovery observed. A prior implementation passed `undefined`
	// for BOTH components here, which let `verifyChainComponent`'s "not yet
	// created" tolerance also (wrongly) cover a `.engineering` deleted or
	// swapped for a different real directory since the plan was computed --
	// `ensureDirectory`'s recursive `mkdir` would then silently recreate
	// `.engineering` itself, and the fresh allocation reload below would
	// compute an ID over that new, empty shell instead of refusing. The type
	// directory may still be created when absent; `.engineering` may not be.
	let chainCheck = await verifyManagedDirectoryChain(deps, projectRoot, targetPath, { engineering: plan.engineeringIdentity })
	if (!chainCheck.ok)
		return { applied: false, outcome: 'rejected', message: `The managed directory chain for '${plan.path}' contains a forbidden symlink or was replaced.` }

	try {
		await deps.ensureDirectory(path.dirname(targetPath))
	}
	catch (error) {
		return { applied: false, outcome: 'incomplete', message: `Failed to ensure the canonical directory for '${plan.path}': ${(error as Error).message}` }
	}

	// Re-verify again immediately before the temporary write: a symlink or a
	// different-directory swap substituted into the chain during/after
	// `ensureDirectory` itself must still be caught before any file content
	// is written through it. Bound to the identity `chainCheck` above just
	// captured, not merely a fresh symlink check, so a component silently
	// replaced with a *different* real directory is caught too.
	chainCheck = await verifyManagedDirectoryChain(deps, projectRoot, targetPath, chainCheck.identity)
	if (!chainCheck.ok)
		return { applied: false, outcome: 'rejected', message: `The managed directory chain for '${plan.path}' contains a forbidden symlink or was replaced.` }

	const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${deps.generateNonce()}`)

	const writeResult = await deps.writeTempFileComplete(tempPath, plan.bytes)
	if (writeResult.outcome !== 'written')
		return { applied: false, outcome: 'incomplete', message: `Failed to write the temporary file for '${plan.path}'.` }

	let writtenBytes: Uint8Array
	try {
		writtenBytes = await deps.readFileBytes(tempPath)
	}
	catch (error) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'incomplete', message: `Failed to verify the temporary file for '${plan.path}': ${(error as Error).message}` }
	}
	if (!bytesEqual(writtenBytes, plan.bytes)) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'incomplete', message: `Temporary file for '${plan.path}' was not written with the planned bytes.` }
	}

	// Post-write verification (Finding 2b): bind an `lstat` identity to the
	// now-complete, byte-verified temporary file, for later comparison
	// against whatever the canonical target denotes immediately after
	// publication (the post-publication verification below), and re-verify
	// the managed chain again -- before the "allocation still absent"
	// re-check that follows -- so a symlink or different-directory swap
	// substituted into the chain during the write itself is still caught
	// here rather than only discovered afterward.
	const tempIdentity = await deps.fileIdentity(tempPath)
	if (tempIdentity === undefined) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'incomplete', message: `Failed to verify the temporary file's identity for '${plan.path}'.` }
	}

	chainCheck = await verifyManagedDirectoryChain(deps, projectRoot, targetPath, chainCheck.identity)
	if (!chainCheck.ok) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'rejected', message: `The managed directory chain for '${plan.path}' contains a forbidden symlink or was replaced.` }
	}

	if (await targetExists(deps, targetPath)) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'raced', message: `'${plan.path}' already exists.` }
	}

	// Post-write allocation re-verification (Finding 2, ninth round): the
	// `targetExists` check just above proves only that THIS invocation's own
	// candidate path is still unclaimed -- it says nothing about whether the
	// requested prefix's ALLOCATION itself remains valid. Another writer can
	// make a higher same-prefix Artifact visible (at a different path)
	// strictly between plan computation and this call without ever touching
	// `targetPath`; see `verifyAllocationStillValid`'s own doc for the exact
	// REQ-002/REQ-999 reproduction. Any change here invalidates the plan --
	// reported as the same typed race-rejection class as an already-published
	// target (13-cli-contract.md's exit `1` "a race that invalidates a
	// mutation plan").
	const allocationCheck = await verifyAllocationStillValid(deps, projectRoot, plan)
	if (!allocationCheck.ok) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'raced', message: allocationCheck.message }
	}

	// Re-verify again immediately before hard-link publication: a symlink or
	// a different-directory swap substituted into the chain during the
	// temporary write itself must still be caught before the canonical
	// target is created through it.
	chainCheck = await verifyManagedDirectoryChain(deps, projectRoot, targetPath, chainCheck.identity)
	if (!chainCheck.ok) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'rejected', message: `The managed directory chain for '${plan.path}' contains a forbidden symlink or was replaced.` }
	}

	const publishResult = await deps.publishViaHardLink(tempPath, targetPath)

	if (publishResult.outcome === 'published') {
		// Post-publication verification (Finding 2a): `publishViaHardLink`
		// reporting success proves only that the `link()` syscall it issued
		// itself succeeded at that instant -- it does not prove the managed
		// chain leading to `targetPath`, or `targetPath` itself, still denotes
		// what this invocation just verified by the time control returns here.
		// Re-verify both: the managed chain identity, and `targetPath`'s own
		// `fstat` identity bound back to `tempIdentity` (a genuine hard link
		// shares the temporary file's exact inode; anything else means
		// `targetPath` was unlinked and replaced, or the chain leading to it
		// was swapped, in the instant after `link()` returned).
		const postChain = await verifyManagedDirectoryChain(deps, projectRoot, targetPath, chainCheck.identity)
		const publishedIdentity = await deps.fileIdentity(targetPath)
		const contentIntact = publishedIdentity !== undefined && sameFileIdentity(publishedIdentity, tempIdentity)

		if (postChain.ok && contentIntact) {
			const cleanedUp = await safeUnlink(deps, tempPath)
			if (!cleanedUp) {
				return { applied: true, outcome: 'cleanup-failed', path: plan.path, message: `'${plan.path}' was published and verified successfully, but its now-superfluous temporary file at '${tempPath}' could not be removed afterward.` }
			}
			return { applied: true, outcome: 'applied', path: plan.path }
		}

		// A mismatch was found. Attempt recovery ONLY when ownership of the
		// entry now at `targetPath` is freshly provable by inode identity --
		// re-checked here, independently of `publishedIdentity` above, since
		// state can keep changing right up to the moment of removal.
		// Unlinking anything whose identity we cannot bind back to
		// `tempIdentity` would risk deleting state this invocation never
		// created (Finding 1 applies the identical ownership-proof rule to
		// `.engineering` itself).
		const recoveryIdentity = await deps.fileIdentity(targetPath)
		if (recoveryIdentity !== undefined && sameFileIdentity(recoveryIdentity, tempIdentity)) {
			try {
				await deps.unlink(targetPath)
				await safeUnlink(deps, tempPath)
				return { applied: false, outcome: 'raced', message: `The managed directory chain or published identity for '${plan.path}' no longer matched immediately after publication; the unverified publish was retracted.` }
			}
			catch {
				// Even the proven-owned retraction itself failed: fall through
				// and report `applied: true, outcome: 'incomplete'` below rather
				// than misreport either a clean success or a clean rejection.
			}
		}

		await safeUnlink(deps, tempPath)
		return { applied: true, outcome: 'incomplete', path: plan.path, message: `The published file for '${plan.path}' could not be verified intact immediately after publication and could not be safely retracted; recovery is an explicit operator action.` }
	}
	if (publishResult.outcome === 'target-exists') {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'raced', message: `'${plan.path}' already exists.` }
	}
	if (publishResult.outcome === 'unsupported') {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'unsupported', message: `The worktree filesystem does not support same-filesystem hard-link publication (${publishResult.error.code ?? 'unknown error'}).` }
	}

	await safeUnlink(deps, tempPath)
	return { applied: false, outcome: 'incomplete', message: `Failed to publish '${plan.path}': ${publishResult.error.message}` }
}

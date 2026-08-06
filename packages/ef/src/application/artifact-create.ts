/**
 * `ef artifact create <type>` plan/apply (13-cli-contract.md "Draft Artifact
 * Creation", "Filesystem Write Safety" / "Draft Artifact hard-link
 * publication"; 02-identity.md Allocation; 08-artifact-schemas.md required
 * H2 skeletons per type).
 *
 * `computeCreatePlan` is pure: it maps a CLI type token to an `ArtifactType`
 * (PROJECT is never a valid token here), allocates the next provisional ID
 * over the already-loaded `ProjectSnapshot`'s visible graph via
 * `domain/identity.ts`'s `nextId`, builds the complete draft file bytes (all
 * nine core envelope fields, empty `tags`/`relations`/`resources`, and the
 * type's required H2 headings with empty content), and self-validates the
 * result through the non-graph-dependent domain validators (identity syntax,
 * filename, status, body schema) before ever proposing it for publication.
 *
 * `applyCreatePlan` performs the exact hard-link publication protocol: write
 * the complete file at a temporary same-directory path, validate the written
 * bytes, re-verify the target is still absent, publish via a create-if-absent
 * hard link (treating target-exists as a race rather than a replacement), and
 * unlink the temporary name.
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactType, Envelope } from '../domain/model'
import type { ProjectSnapshot } from './snapshot'
import { mkdir as fsMkdir, unlink as fsUnlink } from 'node:fs/promises'
import path from 'pathe'
import { validateBody } from '../domain/body-schemas'
import { decodeEnvelope } from '../domain/envelope'
import { nextId as domainNextId, validateFilename, validateIdSyntax } from '../domain/identity'
import { validateStatus } from '../domain/lifecycle'
import { CANONICAL_DIR_BY_TYPE, ID_PREFIX_BY_TYPE, SCHEMA_BY_TYPE } from '../domain/model'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { extractSections, parseBody } from '../parsing/markdown'
import { isDirectory, isRegularFile, isSymlink, readFileBytes } from '../platform/fs-facts'
import { publishViaHardLink, writeTempFileComplete } from '../platform/hard-link-publish'
import { generateNonce } from '../platform/nonce'

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
}

export interface ArtifactCreatePlan {
	type: ArtifactType
	id: string
	/** Project-relative canonical path, `/` separators. */
	path: string
	bytes: Uint8Array
	envelope: Envelope
	changes: [{ action: 'create', path: string }]
}

export type ComputeCreatePlanFailureReason
	= | 'invalid-type'
		| 'missing-value'
		| 'target-exists'
		| 'invalid-plan'

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
	const { snapshot, type, title, summary } = input

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
	const id = domainNextId(prefix, collectVisibleIds(snapshot))
	const filePath = `${CANONICAL_DIR_BY_TYPE[artifactType]}/${id}.md`

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
}

export type ApplyCreatePlanResult
	= | { applied: true, path: string }
		| { applied: false, outcome: 'raced', message: string }
		| { applied: false, outcome: 'unsupported', message: string }
		| { applied: false, outcome: 'incomplete', message: string }

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

async function safeUnlink(deps: ApplyCreatePlanDeps, tempPath: string): Promise<void> {
	try {
		await deps.unlink(tempPath)
	}
	catch {
		// Best-effort cleanup only; the outcome already reported does not depend on it.
	}
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

	try {
		await deps.ensureDirectory(path.dirname(targetPath))
	}
	catch (error) {
		return { applied: false, outcome: 'incomplete', message: `Failed to ensure the canonical directory for '${plan.path}': ${(error as Error).message}` }
	}

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

	if (await targetExists(deps, targetPath)) {
		await safeUnlink(deps, tempPath)
		return { applied: false, outcome: 'raced', message: `'${plan.path}' already exists.` }
	}

	const publishResult = await deps.publishViaHardLink(tempPath, targetPath)

	if (publishResult.outcome === 'published') {
		await safeUnlink(deps, tempPath)
		return { applied: true, path: plan.path }
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

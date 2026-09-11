/**
 * EF Core Artifact identity rules (02-identity.md; canonical layout and
 * Artifact discovery scope in 11-filesystem-and-config.md).
 *
 * Pure identity validators and the sequence-number allocator. Inputs arrive
 * as plain decoded values (id/type/path facts); this module performs no
 * filesystem or process access and does not parse envelopes itself.
 */

import type { DiagnosticCode } from './diagnostic-codes'
import type { Diagnostic, RelatedLocation } from './diagnostics'
import type { ArtifactType } from './model'
import { severityOf } from './diagnostic-codes'
import { CANONICAL_DIR_BY_TYPE, compareBytewise, ID_PREFIX_BY_TYPE } from './model'

function makeDiagnostic(
	code: DiagnosticCode,
	message: string,
	options: {
		path?: string
		artifactId?: string
		field?: string
		related?: RelatedLocation[]
	} = {},
): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: options.path,
		artifactId: options.artifactId,
		field: options.field,
		related: options.related ?? [],
	}
}

/** Canonical decimal formatting of a positive sequence number (02-identity). */
function canonicalNumericSuffix(value: bigint): string {
	if (value < 1000n) {
		return value.toString()
			.padStart(3, '0')
	}
	return value.toString()
}

// ---------------------------------------------------------------------------
// validateIdSyntax
// ---------------------------------------------------------------------------

export interface IdSyntaxEnvelope {
	type: ArtifactType
	id: string
}

const KNOWN_PREFIXES = new Set<string>(Object.values(ID_PREFIX_BY_TYPE))

/**
 * Necessary lexical shape: a run of letters, a hyphen, and a run of digits.
 * Whether the letters name a known core prefix and whether the digits are
 * the canonical decimal representation are checked separately below, so
 * that prefix and numeric-form violations remain independently reportable.
 * Case is intentionally unconstrained here: a lowercase or mixed-case
 * prefix (e.g. `req-031`) still has this necessary shape and is a case
 * variant (`EF-ID-011`), not a wholly malformed ID (`EF-ID-001`).
 */
const SHAPE_PATTERN = /^([A-Z]+)-(\d+)$/i

/**
 * Validate 02-identity ID lexical form for one Artifact:
 *
 * - `EF-ID-008`: PROJECT uses an ID other than `PROJECT`.
 * - `EF-ID-001`: the ID does not parse into the necessary prefix-hyphen-digits
 *   shape at all (missing, empty, no hyphen, non-digit suffix, ...).
 * - `EF-ID-011`: the shape parses but the prefix is not one of the five core
 *   prefixes (unsupported, aliased, or case-variant prefix).
 * - `EF-ID-002`: the prefix is a known core prefix but does not match the
 *   Artifact's `type`.
 * - `EF-ID-003`: the numeric component is zero or is not the canonical
 *   decimal representation of its value (padding/zero rules).
 *
 * `EF-ID-002` and `EF-ID-003` are independent invariants and are both
 * reported when both are violated (e.g. `ADR-01` for a requirement).
 */
export function validateIdSyntax(envelope: IdSyntaxEnvelope, path: string): Diagnostic[] {
	const { type, id } = envelope

	if (type === 'project') {
		if (id === 'PROJECT')
			return []
		return [
			makeDiagnostic(
				'EF-ID-008',
				`PROJECT Artifact must use the exact ID 'PROJECT'; found '${id}'.`,
				{ path, artifactId: id, field: 'id' },
			),
		]
	}

	const match = SHAPE_PATTERN.exec(id)
	if (!match) {
		return [
			makeDiagnostic(
				'EF-ID-001',
				`Artifact ID '${id}' is missing or malformed.`,
				{ path, artifactId: id, field: 'id' },
			),
		]
	}

	const prefixToken = match[1]!
	const digitsToken = match[2]!

	if (!KNOWN_PREFIXES.has(prefixToken)) {
		return [
			makeDiagnostic(
				'EF-ID-011',
				`ID prefix '${prefixToken}' is not a supported core prefix.`,
				{ path, artifactId: id, field: 'id' },
			),
		]
	}

	const diagnostics: Diagnostic[] = []
	const expectedPrefix = ID_PREFIX_BY_TYPE[type]

	if (prefixToken !== expectedPrefix) {
		diagnostics.push(makeDiagnostic(
			'EF-ID-002',
			`ID prefix '${prefixToken}' does not match Artifact type '${type}' (expected '${expectedPrefix}').`,
			{ path, artifactId: id, field: 'id' },
		))
	}

	const value = BigInt(digitsToken)
	if (value === 0n) {
		diagnostics.push(makeDiagnostic(
			'EF-ID-003',
			`ID numeric component '${digitsToken}' is zero, which is not a valid sequence number.`,
			{ path, artifactId: id, field: 'id' },
		))
	}
	else if (digitsToken !== canonicalNumericSuffix(value)) {
		diagnostics.push(makeDiagnostic(
			'EF-ID-003',
			`ID numeric component '${digitsToken}' is not the canonical decimal representation of ${value}.`,
			{ path, artifactId: id, field: 'id' },
		))
	}

	return diagnostics
}

// ---------------------------------------------------------------------------
// validateFilename
// ---------------------------------------------------------------------------

export interface FilenameEnvelope {
	type: ArtifactType
	id: string
}

function splitPath(path: string): { directory: string, basename: string } {
	const slashIndex = path.lastIndexOf('/')
	if (slashIndex === -1)
		return { directory: '', basename: path }
	return { directory: path.slice(0, slashIndex), basename: path.slice(slashIndex + 1) }
}

/**
 * Validate 02-identity filename rules and 11-filesystem-and-config canonical
 * directory placement for one Artifact file:
 *
 * - `EF-ID-005`: the basename does not exactly equal `<id>.md` (byte for
 *   byte, including case and extension).
 * - `EF-ID-014`: the file does not sit directly inside its type's canonical
 *   directory (`CANONICAL_DIR_BY_TYPE`).
 *
 * Both are independently detectable and may both be reported for one file.
 */
export function validateFilename(envelope: FilenameEnvelope, path: string): Diagnostic[] {
	const { type, id } = envelope
	const diagnostics: Diagnostic[] = []
	const { directory, basename } = splitPath(path)
	const expectedBasename = `${id}.md`

	if (basename !== expectedBasename) {
		diagnostics.push(makeDiagnostic(
			'EF-ID-005',
			`Filename '${basename}' does not match Artifact ID '${id}'; expected '${expectedBasename}'.`,
			{ path, artifactId: id },
		))
	}

	const expectedDirectory = CANONICAL_DIR_BY_TYPE[type]
	if (directory !== expectedDirectory) {
		diagnostics.push(makeDiagnostic(
			'EF-ID-014',
			`Artifact file is outside its canonical directory; expected it directly inside '${expectedDirectory}'.`,
			{ path, artifactId: id },
		))
	}

	return diagnostics
}

// ---------------------------------------------------------------------------
// validateGraphIdentity
// ---------------------------------------------------------------------------

export interface GraphIdentityArtifact {
	id: string
	type: ArtifactType
	path: string
}

/** The bytewise-smallest path among `entries` (09-validation multi-file primary rule). */
function primaryByPath<T extends { path: string }>(entries: readonly T[]): T {
	return entries.reduce((min, entry) => (compareBytewise(entry.path, min.path) < 0 ? entry : min))
}

/**
 * Validate identity rules that require the complete Artifact graph:
 *
 * - `EF-ID-004`: two or more files declare the same Artifact ID. The
 *   bytewise-smallest path is the primary location; every other file is a
 *   related location.
 * - `EF-ID-007`: no PROJECT Artifact is present.
 * - `EF-ID-006`: more than one PROJECT Artifact is present (regardless of the
 *   ID each one declares).
 *
 * The same numeric component under different type prefixes (e.g. `REQ-001`
 * and `ADR-001`) is never a duplicate.
 */
export function validateGraphIdentity(artifacts: readonly GraphIdentityArtifact[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	const byId = new Map<string, GraphIdentityArtifact[]>()
	for (const artifact of artifacts) {
		const group = byId.get(artifact.id)
		if (group)
			group.push(artifact)
		else
			byId.set(artifact.id, [artifact])
	}

	for (const group of byId.values()) {
		if (group.length < 2)
			continue
		const primary = primaryByPath(group)
		const others = group
			.filter(entry => entry !== primary)
			.sort((a, b) => compareBytewise(a.path, b.path))
		diagnostics.push(makeDiagnostic(
			'EF-ID-004',
			`Artifact ID '${primary.id}' is duplicated.`,
			{
				path: primary.path,
				artifactId: primary.id,
				related: others.map(entry => ({
					path: entry.path,
					message: 'Duplicate identity is also declared here.',
				})),
			},
		))
	}

	const projectArtifacts = artifacts.filter(artifact => artifact.type === 'project')

	if (projectArtifacts.length === 0) {
		diagnostics.push(makeDiagnostic(
			'EF-ID-007',
			'The project is missing a required PROJECT Artifact.',
		))
	}
	else if (projectArtifacts.length > 1) {
		const primary = primaryByPath(projectArtifacts)
		const others = projectArtifacts
			.filter(entry => entry !== primary)
			.sort((a, b) => compareBytewise(a.path, b.path))
		diagnostics.push(makeDiagnostic(
			'EF-ID-006',
			'More than one PROJECT Artifact exists.',
			{
				path: primary.path,
				artifactId: primary.id,
				related: others.map(entry => ({
					path: entry.path,
					message: 'Another PROJECT Artifact is declared here.',
				})),
			},
		))
	}

	return diagnostics
}

// ---------------------------------------------------------------------------
// nextId
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Allocate the next canonical sequence number for `prefix` (02-identity
 * Allocation): find the greatest numeric component among `existingIds`
 * sharing `prefix`, using arbitrary-precision integer comparison, and return
 * `<prefix>-<next>` in canonical decimal form. Never fills numeric gaps; an
 * absent or non-matching existing set allocates `<prefix>-001`.
 */
export function nextId(prefix: string, existingIds: readonly string[]): string {
	const pattern = new RegExp(`^${escapeRegExp(prefix)}-([0-9]+)$`)
	let max = 0n

	for (const id of existingIds) {
		const match = pattern.exec(id)
		if (!match)
			continue
		const value = BigInt(match[1]!)
		if (value > max)
			max = value
	}

	const next = max + 1n
	return `${prefix}-${canonicalNumericSuffix(next)}`
}

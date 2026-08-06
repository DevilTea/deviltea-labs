/**
 * EF Core Resource validation (06-resources).
 *
 * This module is pure logic: every input arrives as a value (a decoded
 * envelope-like object, prepared file facts, prepared project facts). It
 * performs no filesystem or process access.
 *
 * `validateResourceDescriptors` receives raw, not-yet-field-validated
 * `resources` entries (each entry is `unknown`, expected to be a plain
 * mapping using the original YAML field names -- `type`, `location`, `role`,
 * `media_type`, `normative`, `description`, plus `x-*` extensions) rather
 * than the fully validated `ResourceDescriptor` shape from `./model`. That
 * stricter shape is the *result* of a descriptor passing this module's
 * shape/vocabulary checks; requiring it as this function's input would make
 * the EF-RES-001/EF-RES-019 checks unreachable. See the accompanying test
 * file and the final implementation report for the reasoning.
 */

import type { DiagnosticCode } from './diagnostic-codes'
import type { Diagnostic, RelatedLocation } from './diagnostics'
import { severityOf } from './diagnostic-codes'
import { aggregateDiagnostics } from './diagnostics'
import { compareBytewise, RESOURCE_ROLES, RESOURCE_TYPES } from './model'

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Canonical core-field order for a Resource descriptor (06-resources "Canonical ordering"). */
const CORE_RESOURCE_FIELDS = ['type', 'location', 'role', 'media_type', 'normative', 'description'] as const

const CORE_RESOURCE_FIELD_SET: ReadonlySet<string> = new Set(CORE_RESOURCE_FIELDS)

/** Shared with the envelope extension-name rule (01-artifact-envelope.md). */
const EXTENSION_FIELD_PATTERN = /^x-[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/

/** Full media type pattern (06-resources "Media type"): type and subtype each match `[a-z0-9][a-z0-9!#$&^_.+-]*`, joined by a slash. */
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

const NON_NORMATIVE_ROLES = new Set(['explanation', 'example', 'reference', 'prototype', 'asset'])

/** The fixed EF-RES-018 suffix -> expected media type table (06-resources "Media type"). */
const SUFFIX_MEDIA_TYPE_TABLE: ReadonlyMap<string, string> = new Map([
	['.csv', 'text/csv'],
	['.html', 'text/html'],
	['.htm', 'text/html'],
	['.json', 'application/json'],
	['.md', 'text/markdown'],
	['.pdf', 'application/pdf'],
	['.png', 'image/png'],
	['.svg', 'image/svg+xml'],
	['.yaml', 'application/yaml'],
	['.yml', 'application/yaml'],
])

const MANAGED_RESOURCE_ROOT = '.engineering/resources/'

// ---------------------------------------------------------------------------
// Input contracts (this module's own, per assignment: pure logic, small
// caller-supplied input interfaces).
// ---------------------------------------------------------------------------

/**
 * Minimal decoded-envelope shape this module needs: the owning Artifact ID
 * (02-identity, anchors the EF-RES-014 owner-directory rule) and the raw
 * `resources` entries as decoded from YAML/JSON prior to per-field
 * validation. An already-fully-decoded `Envelope` (./model) also satisfies
 * this shape structurally.
 */
export interface ResourceEnvelopeInput {
	/** Owning Artifact ID. */
	id: string
	/** Raw `resources` array entries, each expected to be a mapping. */
	resources: readonly unknown[]
}

// ---------------------------------------------------------------------------
// Diagnostic construction
// ---------------------------------------------------------------------------

interface DiagnosticInit {
	path?: string
	artifactId?: string
	field?: string
	related?: RelatedLocation[]
}

function makeDiagnostic(code: DiagnosticCode, message: string, init: DiagnosticInit = {}): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path: init.path,
		artifactId: init.artifactId,
		field: init.field,
		related: init.related ?? [],
	}
}

function entryField(index: number): string {
	return `resources[${index}]`
}

function subField(index: number, key: string): string {
	return `${entryField(index)}.${key}`
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getStringField(entry: Record<string, unknown>, key: string): string | undefined {
	const value = entry[key]
	return typeof value === 'string' ? value : undefined
}

/** JSON-compatible per 01-artifact-envelope.md "Extension fields": string, finite number, boolean, null, array, or mapping with string keys. */
function isJsonCompatible(value: unknown, seen: Set<unknown> = new Set()): boolean {
	if (value === null)
		return true
	const type = typeof value
	if (type === 'string' || type === 'boolean')
		return true
	if (type === 'number')
		return Number.isFinite(value)
	if (type !== 'object')
		return false
	if (seen.has(value))
		return false
	seen.add(value)
	if (Array.isArray(value))
		return value.every(item => isJsonCompatible(item, seen))
	return Object.values(value as Record<string, unknown>)
		.every(item => isJsonCompatible(item, seen))
}

/** Canonical key order: core fields present (in canonical order), then remaining keys sorted bytewise. */
function canonicalKeyOrder(keys: readonly string[]): string[] {
	const core = CORE_RESOURCE_FIELDS.filter(field => keys.includes(field))
	const rest = keys.filter(key => !CORE_RESOURCE_FIELD_SET.has(key))
		.sort(compareBytewise)
	return [...core, ...rest]
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

// ---------------------------------------------------------------------------
// Location classification
// ---------------------------------------------------------------------------

type LocationAnalysis
	= | { kind: 'empty' }
		| { kind: 'unsupported-scheme' }
		| { kind: 'external', valid: false }
		| { kind: 'external', valid: true, insecure: boolean }
		| { kind: 'local', valid: false, violation: 'backslash' | 'root-escape' | 'segment' }
		| { kind: 'local', valid: true, segments: string[] }

// eslint-disable-next-line no-control-regex -- intentionally matches ASCII control characters and whitespace (06-resources "External URLs").
const CONTROL_OR_WHITESPACE_PATTERN = /[\x00-\x20\x7F]/
// eslint-disable-next-line no-control-regex -- intentionally matches any non-ASCII character by excluding the full ASCII range, including control characters.
const NON_ASCII_PATTERN = /[^\x00-\x7F]/
const MALFORMED_PERCENT_ESCAPE_PATTERN = /%(?![0-9A-F]{2})/i

function analyzeExternalLocation(location: string): LocationAnalysis {
	if (CONTROL_OR_WHITESPACE_PATTERN.test(location) || NON_ASCII_PATTERN.test(location) || MALFORMED_PERCENT_ESCAPE_PATTERN.test(location))
		return { kind: 'external', valid: false }

	// The WHATWG URL parser collapses a spurious extra slash after the
	// authority marker (e.g. "https:///a" parses "a" as the hostname). Reject
	// an empty or slash-led remainder ourselves so an empty authority/host is
	// never silently reinterpreted as a valid one.
	const prefixLength = location.startsWith('https://') ? 8 : 7
	const remainder = location.slice(prefixLength)
	if (remainder.length === 0 || remainder.startsWith('/'))
		return { kind: 'external', valid: false }

	let url: URL
	try {
		url = new URL(location)
	}
	catch {
		return { kind: 'external', valid: false }
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		return { kind: 'external', valid: false }
	if (url.username !== '' || url.password !== '')
		return { kind: 'external', valid: false }
	if (url.hostname.length === 0)
		return { kind: 'external', valid: false }

	return { kind: 'external', valid: true, insecure: location.startsWith('http://') }
}

/** Classify and syntax-check a `location` value per 06-resources "Location classification" / "Local path resolution" / "External URLs". */
function analyzeLocation(location: string): LocationAnalysis {
	if (location.length === 0)
		return { kind: 'empty' }

	if (location.startsWith('https://') || location.startsWith('http://'))
		return analyzeExternalLocation(location)

	if (location.includes(':'))
		return { kind: 'unsupported-scheme' }

	if (location.includes('\\'))
		return { kind: 'local', valid: false, violation: 'backslash' }

	if (location.startsWith('/') || location.startsWith('~'))
		return { kind: 'local', valid: false, violation: 'root-escape' }

	const segments = location.split('/')
	if (segments.some(segment => segment === '' || segment === '.' || segment === '..'))
		return { kind: 'local', valid: false, violation: 'segment' }

	return { kind: 'local', valid: true, segments }
}

// ---------------------------------------------------------------------------
// validateResourceDescriptors (EF-RES-001..005, 007, 008, 010, 011, 014,
// 016..019)
// ---------------------------------------------------------------------------

/**
 * Validate the `resources` entries of one decoded Artifact envelope against
 * every descriptor-local rule in 06-resources: shape, vocabulary, location
 * syntax and classification, media type, normative/role compatibility,
 * duplicate locations within the Artifact, canonical ordering, and unknown
 * or invalid extension fields.
 *
 * Rules requiring filesystem state, complete-project ownership, or
 * before/after lifecycle context (EF-RES-006, 009, 012, 013, 015) are out of
 * scope for this function; see the project-level checks below.
 */
export function validateResourceDescriptors(envelope: ResourceEnvelopeInput, path: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const artifactId = envelope.id
	const ownerPrefix = `${MANAGED_RESOURCE_ROOT}${artifactId}/`

	function report(code: DiagnosticCode, message: string, field: string, related?: RelatedLocation[]): void {
		diagnostics.push(makeDiagnostic(code, message, { path, artifactId, field, related }))
	}

	const locationFirstIndex = new Map<string, number>()
	const orderedLocations: { index: number, location: string }[] = []

	envelope.resources.forEach((raw, index) => {
		if (!isPlainObject(raw)) {
			report('EF-RES-001', 'Resource descriptor must be a mapping.', entryField(index))
			return
		}

		const entry = raw
		const typeVal = getStringField(entry, 'type')
		const locationVal = getStringField(entry, 'location')
		const roleVal = getStringField(entry, 'role')
		const mediaTypeVal = getStringField(entry, 'media_type')
		const normativeVal = typeof entry.normative === 'boolean' ? entry.normative : undefined
		const descriptionVal = getStringField(entry, 'description')

		if (typeVal === undefined)
			report('EF-RES-001', 'Resource field \'type\' is required and must be a string.', subField(index, 'type'))
		if (locationVal === undefined)
			report('EF-RES-001', 'Resource field \'location\' is required and must be a string.', subField(index, 'location'))
		if (roleVal === undefined)
			report('EF-RES-001', 'Resource field \'role\' is required and must be a string.', subField(index, 'role'))
		if (mediaTypeVal === undefined)
			report('EF-RES-001', 'Resource field \'media_type\' is required and must be a string.', subField(index, 'media_type'))
		if (normativeVal === undefined)
			report('EF-RES-001', 'Resource field \'normative\' is required and must be a boolean.', subField(index, 'normative'))
		if (descriptionVal === undefined)
			report('EF-RES-001', 'Resource field \'description\' is required and must be a string.', subField(index, 'description'))
		else if (descriptionVal.trim().length === 0)
			report('EF-RES-001', 'Resource field \'description\' must not be empty.', subField(index, 'description'))

		if (typeVal !== undefined && !(RESOURCE_TYPES as readonly string[]).includes(typeVal) && !EXTENSION_FIELD_PATTERN.test(typeVal))
			report('EF-RES-002', `Resource type '${typeVal}' is unknown and is not a namespaced extension type.`, subField(index, 'type'))

		if (roleVal !== undefined && !(RESOURCE_ROLES as readonly string[]).includes(roleVal))
			report('EF-RES-003', `Resource role '${roleVal}' is unknown.`, subField(index, 'role'))

		if (mediaTypeVal !== undefined && !MEDIA_TYPE_PATTERN.test(mediaTypeVal))
			report('EF-RES-005', `Media type '${mediaTypeVal}' is malformed or non-canonical.`, subField(index, 'media_type'))

		if (locationVal !== undefined) {
			orderedLocations.push({ index, location: locationVal })

			if (locationFirstIndex.has(locationVal)) {
				const firstIndex = locationFirstIndex.get(locationVal)!
				report('EF-RES-008', `Duplicate Resource location '${locationVal}' within one Artifact.`, subField(index, 'location'), [
					{ path, artifactId, field: subField(firstIndex, 'location'), message: `First occurrence of location '${locationVal}'.` },
				])
			}
			else {
				locationFirstIndex.set(locationVal, index)
			}

			const analysis = analyzeLocation(locationVal)

			if (analysis.kind === 'empty') {
				report('EF-RES-004', 'Location is empty.', subField(index, 'location'))
			}
			else if (analysis.kind === 'unsupported-scheme') {
				report('EF-RES-004', `Location '${locationVal}' uses an unsupported or ambiguous scheme.`, subField(index, 'location'))
			}
			else if (analysis.kind === 'external' && !analysis.valid) {
				report('EF-RES-004', `Location '${locationVal}' is not a syntactically valid absolute HTTP(S) URL.`, subField(index, 'location'))
			}
			else if (analysis.kind === 'external' && analysis.valid) {
				if (normativeVal === true)
					report('EF-RES-010', 'An external Resource must not be marked normative.', subField(index, 'normative'))
				if (analysis.insecure)
					report('EF-RES-017', `Location '${locationVal}' uses insecure HTTP rather than HTTPS.`, subField(index, 'location'))
			}
			else if (analysis.kind === 'local' && !analysis.valid && analysis.violation === 'backslash') {
				report('EF-RES-004', `Location '${locationVal}' contains a forbidden backslash.`, subField(index, 'location'))
			}
			else if (analysis.kind === 'local' && !analysis.valid) {
				const message = analysis.violation === 'root-escape'
					? `Location '${locationVal}' must not begin with '/' or '~'.`
					: `Location '${locationVal}' contains an empty, '.', or '..' path segment.`
				report('EF-RES-007', message, subField(index, 'location'))
			}
			else if (analysis.kind === 'local' && analysis.valid) {
				if (!locationVal.startsWith(ownerPrefix))
					report('EF-RES-014', `Location '${locationVal}' is not beneath the owner's managed Resource directory '${ownerPrefix}'.`, subField(index, 'location'))

				if (mediaTypeVal !== undefined && MEDIA_TYPE_PATTERN.test(mediaTypeVal)) {
					const basename = analysis.segments[analysis.segments.length - 1] ?? ''
					const dotIndex = basename.lastIndexOf('.')
					if (dotIndex > 0) {
						const suffix = basename.slice(dotIndex)
							.toLowerCase()
						const expected = SUFFIX_MEDIA_TYPE_TABLE.get(suffix)
						if (expected !== undefined && expected !== mediaTypeVal) {
							report('EF-RES-018', `File suffix '${suffix}' expects media type '${expected}' but declares '${mediaTypeVal}'.`, subField(index, 'media_type'))
						}
					}
				}
			}
		}

		if (roleVal !== undefined && normativeVal !== undefined && (RESOURCE_ROLES as readonly string[]).includes(roleVal)) {
			if (roleVal === 'contract' && normativeVal !== true)
				report('EF-RES-011', 'Role \'contract\' requires \'normative: true\'.', subField(index, 'normative'))
			else if (NON_NORMATIVE_ROLES.has(roleVal) && normativeVal !== false)
				report('EF-RES-011', `Role '${roleVal}' requires 'normative: false'.`, subField(index, 'normative'))
		}

		for (const key of Object.keys(entry)) {
			if (CORE_RESOURCE_FIELD_SET.has(key))
				continue
			if (EXTENSION_FIELD_PATTERN.test(key)) {
				if (!isJsonCompatible(entry[key]))
					report('EF-RES-019', `Extension field '${key}' has a non-JSON-compatible value.`, subField(index, key))
			}
			else {
				report('EF-RES-019', `Unknown Resource field '${key}'.`, subField(index, key))
			}
		}

		const actualKeys = Object.keys(entry)
		const canonicalKeys = canonicalKeyOrder(actualKeys)
		if (!sameOrder(actualKeys, canonicalKeys))
			report('EF-RES-016', 'Resource descriptor fields are not in canonical order.', entryField(index))
	})

	let orderViolation = false
	for (let i = 1; i < orderedLocations.length; i++) {
		if (compareBytewise(orderedLocations[i - 1]!.location, orderedLocations[i]!.location) > 0) {
			orderViolation = true
			break
		}
	}
	if (orderViolation)
		report('EF-RES-016', 'Resource descriptors are not sorted by location in bytewise lexicographic order.', 'resources')

	return aggregateDiagnostics(diagnostics)
}

// ---------------------------------------------------------------------------
// Project-level pure checks over prepared facts
// ---------------------------------------------------------------------------

/** One Artifact's ownership claim over a local Resource `location`, for EF-RES-009. */
export interface ResourceOwnershipEntry {
	artifactId: string
	path: string
	location: string
}

/** EF-RES-009: a local Resource location claimed by more than one owning Artifact across the project. */
export function validateResourceOwnership(entries: readonly ResourceOwnershipEntry[]): Diagnostic[] {
	const byLocation = new Map<string, ResourceOwnershipEntry[]>()
	for (const entry of entries) {
		const list = byLocation.get(entry.location)
		if (list) {
			list.push(entry)
		}
		else {
			byLocation.set(entry.location, [entry])
		}
	}

	const diagnostics: Diagnostic[] = []
	for (const [location, owners] of byLocation) {
		const distinctArtifactIds = new Set(owners.map(owner => owner.artifactId))
		if (distinctArtifactIds.size <= 1)
			continue

		for (const owner of owners) {
			const related: RelatedLocation[] = owners
				.filter(other => other !== owner)
				.map(other => ({
					path: other.path,
					artifactId: other.artifactId,
					field: 'location',
					message: `Also claimed by '${other.artifactId}'.`,
				}))
			diagnostics.push(makeDiagnostic(
				'EF-RES-009',
				`Local Resource location '${location}' has multiple owners.`,
				{ path: owner.path, artifactId: owner.artifactId, field: 'location', related },
			))
		}
	}

	return aggregateDiagnostics(diagnostics)
}

/** Filesystem state of a declared local Resource location, as prepared by the caller (no filesystem access here). */
export type LocalResourceFileState = 'file' | 'directory' | 'symlink' | 'missing'

/** A declared local Resource requiring EF-RES-006 file-existence validation. */
export interface LocalResourceFileEntry {
	artifactId: string
	path: string
	location: string
}

/**
 * EF-RES-006: a declared local Resource whose resolved file does not exist
 * or is not a regular file. Entries whose `location` is not a syntactically
 * local path (per `analyzeLocation`) are ignored; only locations that
 * `validateResourceDescriptors` would classify as valid local paths are
 * meaningful here.
 */
export function validateLocalResourceFiles(
	entries: readonly LocalResourceFileEntry[],
	fileFacts: ReadonlyMap<string, LocalResourceFileState>,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	for (const entry of entries) {
		const analysis = analyzeLocation(entry.location)
		if (analysis.kind !== 'local' || !analysis.valid)
			continue

		const state = fileFacts.get(entry.location) ?? 'missing'
		if (state === 'file')
			continue

		const message = state === 'missing'
			? `Local Resource file '${entry.location}' does not exist.`
			: `Local Resource file '${entry.location}' is not a regular file (${state}).`
		diagnostics.push(makeDiagnostic('EF-RES-006', message, { path: entry.path, artifactId: entry.artifactId, field: 'location' }))
	}
	return aggregateDiagnostics(diagnostics)
}

/**
 * EF-RES-015: a file inside the EF-managed `.engineering/resources/` root
 * that has no owning descriptor. `managedRootFiles` is the caller-supplied
 * list of every file found under that root; `declaredLocations` is the
 * complete set of locations declared by some Artifact's `resources` array.
 */
export function findOrphanResourceFiles(
	managedRootFiles: readonly string[],
	declaredLocations: ReadonlySet<string>,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	for (const file of managedRootFiles) {
		if (!declaredLocations.has(file))
			diagnostics.push(makeDiagnostic('EF-RES-015', `Unowned file '${file}' exists inside the managed Resource root.`, { path: file }))
	}
	return aggregateDiagnostics(diagnostics)
}

/** One Resource's descriptor content and (for local Resources) content identity, at a point in time. */
export interface ResourceContentState {
	location: string
	type: string
	role: string
	mediaType: string
	normative: boolean
	description: string
	extensions: Record<string, unknown>
	/** Content identity for a local Resource's file content (e.g. a hash); omitted for external locations. */
	contentHash?: string
}

/** An owning Artifact's Resource set at one point in time, for EF-RES-013. */
export interface OwnerResourceSnapshot {
	artifactId: string
	path: string
	/** Whether the owner was already in a frozen lifecycle state (03-lifecycle) at this snapshot. */
	frozen: boolean
	resources: readonly ResourceContentState[]
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b)
		return true
	if (typeof a !== typeof b)
		return false
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
		return false

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false
		return a.every((item, index) => deepEqual(item, b[index]))
	}

	const aRecord = a as Record<string, unknown>
	const bRecord = b as Record<string, unknown>
	const aKeys = Object.keys(aRecord)
	const bKeys = Object.keys(bRecord)
	if (aKeys.length !== bKeys.length)
		return false
	return aKeys.every(key => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]))
}

function resourceContentEqual(a: ResourceContentState, b: ResourceContentState): boolean {
	return a.type === b.type
		&& a.role === b.role
		&& a.mediaType === b.mediaType
		&& a.normative === b.normative
		&& a.description === b.description
		&& a.contentHash === b.contentHash
		&& deepEqual(a.extensions, b.extensions)
}

/**
 * EF-RES-013: a frozen owner's Resource descriptor or local file content was
 * added, removed, or modified between `before` and `after`. No violation is
 * reported when `before.frozen` is `false` -- the terminal transition itself
 * may legitimately change Resources atomically with becoming frozen.
 */
export function validateFrozenResourceMutation(
	before: OwnerResourceSnapshot,
	after: OwnerResourceSnapshot,
): Diagnostic[] {
	if (!before.frozen)
		return []

	const diagnostics: Diagnostic[] = []
	const beforeByLocation = new Map(before.resources.map(resource => [resource.location, resource] as const))
	const afterByLocation = new Map(after.resources.map(resource => [resource.location, resource] as const))
	const allLocations = new Set([...beforeByLocation.keys(), ...afterByLocation.keys()])

	for (const location of allLocations) {
		const beforeResource = beforeByLocation.get(location)
		const afterResource = afterByLocation.get(location)

		let message: string | undefined
		if (beforeResource && !afterResource)
			message = `Frozen owner's Resource '${location}' was removed.`
		else if (!beforeResource && afterResource)
			message = `Frozen owner's Resource '${location}' was added.`
		else if (beforeResource && afterResource && !resourceContentEqual(beforeResource, afterResource))
			message = `Frozen owner's Resource '${location}' was modified.`

		if (message !== undefined) {
			diagnostics.push(makeDiagnostic('EF-RES-013', message, {
				path: after.path,
				artifactId: after.artifactId,
				field: location,
			}))
		}
	}

	return aggregateDiagnostics(diagnostics)
}

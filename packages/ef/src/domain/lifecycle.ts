/**
 * EF Core artifact lifecycle validation (docs/ef-core/03-lifecycle.md).
 *
 * Pure functions only: every input arrives as a plain value supplied by the
 * caller (decoded envelope fields, previous-state facts). No filesystem or
 * process access happens here.
 */

import type { Diagnostic } from './diagnostics'
import type { ArtifactType, Status } from './model'
import { severityOf } from './diagnostic-codes'
import { ALLOWED_STATUSES, ALLOWED_TRANSITIONS, STATUSES } from './model'

const STATUS_SET: ReadonlySet<string> = new Set(STATUSES)

/** The minimal envelope fields lifecycle status validation needs. */
export interface StatusCheckInput {
	type: ArtifactType
	/** Raw decoded value; not yet known to be a member of the status vocabulary. */
	status: string
	id?: string
}

/**
 * Checks a single Artifact's `status` field against the status vocabulary and
 * the type's allowed-status table (03-lifecycle Schema: Status applicability).
 *
 * Emits at most one diagnostic:
 * - `EF-LIFE-001` when `status` is not one of the five vocabulary statuses.
 * - `EF-LIFE-002` when `status` is a known status but not allowed for `type`.
 */
export function validateStatus(envelope: StatusCheckInput, path: string): Diagnostic[] {
	const { type, status, id } = envelope

	if (!STATUS_SET.has(status)) {
		return [{
			code: 'EF-LIFE-001',
			severity: severityOf('EF-LIFE-001'),
			message: `Unknown lifecycle status "${status}".`,
			path,
			artifactId: id,
			field: 'status',
			related: [],
		}]
	}

	const allowed = ALLOWED_STATUSES[type]
	if (!allowed.includes(status as Status)) {
		return [{
			code: 'EF-LIFE-002',
			severity: severityOf('EF-LIFE-002'),
			message: `Status "${status}" is not allowed for Artifact type "${type}". Allowed: ${allowed.join(', ')}.`,
			path,
			artifactId: id,
			field: 'status',
			related: [],
		}]
	}

	return []
}

/** Artifact types that carry current canonical engineering truth when `active` (03-lifecycle). */
const KNOWLEDGE_TYPES: ReadonlySet<ArtifactType> = new Set(['prd', 'requirement', 'decision', 'policy'] satisfies ArtifactType[])

/**
 * Statuses a fresh Artifact of each type may carry on its first authoritative
 * appearance (03-lifecycle, "First authoritative appearance"). This is a
 * subset of `ALLOWED_STATUSES` for knowledge types: `superseded` and
 * `retired` are valid statuses in general but never as a first appearance.
 */
const FIRST_APPEARANCE_ALLOWED: Record<ArtifactType, readonly Status[]> = {
	project: ['active'],
	prd: ['draft', 'active'],
	requirement: ['draft', 'active'],
	decision: ['draft', 'active'],
	policy: ['draft', 'active'],
	change: ['draft', 'completed', 'retired'],
}

export interface TransitionCheckInput {
	type: ArtifactType
	/** The Artifact's status in the trusted baseline; `undefined` means first authoritative appearance. */
	before: Status | undefined
	/** The Artifact's status in the proposed authoritative state. */
	after: Status
	id?: string
	path?: string
	/**
	 * Whether a completed CHG `introduces` effect for this Artifact exists.
	 * Only consulted when a knowledge Artifact (PRD, REQ, ADR, POL) first
	 * appears as `active`; ignored otherwise.
	 */
	introducedByCompletedChg?: boolean
	/**
	 * Whether this first appearance occurs during EF project bootstrap, which
	 * exempts the CHG-introduces requirement above ("except during bootstrap").
	 */
	isProjectBootstrap?: boolean
}

/**
 * Validates one lifecycle status change: legal transitions per
 * `ALLOWED_TRANSITIONS`, and first-authoritative-appearance rules when
 * `before` is `undefined` (03-lifecycle, "First authoritative appearance").
 *
 * Setting a status to its existing value is not a lifecycle transition and is
 * never flagged here (03-lifecycle, "Transition sets").
 */
export function validateTransition(input: TransitionCheckInput): Diagnostic[] {
	const { type, before, after, id, path, introducedByCompletedChg, isProjectBootstrap } = input

	function illegal(message: string): Diagnostic[] {
		return [{
			code: 'EF-LIFE-003',
			severity: severityOf('EF-LIFE-003'),
			message,
			path,
			artifactId: id,
			field: 'status',
			related: [],
		}]
	}

	if (before === undefined) {
		const allowed = FIRST_APPEARANCE_ALLOWED[type]
		if (!allowed.includes(after))
			return illegal(`Artifact type "${type}" MUST NOT first appear with status "${after}".`)

		if (after === 'active' && KNOWLEDGE_TYPES.has(type) && !introducedByCompletedChg && !isProjectBootstrap)
			return illegal(`Artifact type "${type}" first appearing as "active" requires a completed CHG "introduces" effect, except during EF project bootstrap.`)

		return []
	}

	if (before === after)
		return []

	const legal = ALLOWED_TRANSITIONS[type].some(([from, to]) => from === before && to === after)
	if (!legal)
		return illegal(`Illegal lifecycle transition for Artifact type "${type}": "${before}" -> "${after}".`)

	return []
}

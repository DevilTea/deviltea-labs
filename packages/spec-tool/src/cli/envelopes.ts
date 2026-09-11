/**
 * Stable JSON envelope construction (13-cli-contract.md "Validation JSON",
 * "Mutation JSON", "Query Commands", "Version and Help").
 *
 * Every envelope builder here returns a plain JSON-serializable object whose
 * shape exactly matches its documented schema, with every required key
 * present (using explicit `null` for a documented-nullable absent value,
 * never an omitted key). Diagnostics are converted through
 * `./diagnostics-json` uniformly.
 */

import type { ArtifactSummaryProjection } from '../application/query-projection'
import type { QueryResult } from '../application/query-types'
import type { ValidationSummary } from '../application/snapshot-validation'
import type { Diagnostic } from '../domain/diagnostics'
import type { ExitCode } from './exit'
import { compareBytewise } from '../domain/model'
import { diagnosticsToJson } from './diagnostics-json'

// ---------------------------------------------------------------------------
// ef/validation-result@1
// ---------------------------------------------------------------------------

export interface ValidationResultJson {
	schema: 'ef/validation-result@1'
	kind: 'validation'
	scope: 'snapshot' | 'transition' | 'bootstrap' | 'range'
	baseline_oid: string | null
	proposed_oid: string | null
	integration_ref: string | null
	expected_ref_oid: string | null
	strict: boolean
	warnings_as_errors: boolean
	workspace: boolean
	complete: boolean
	valid: boolean
	counts: { error: number, warning: number, info: number }
	exit_code: ExitCode
	diagnostics: ReturnType<typeof diagnosticsToJson>
}

export function buildValidationResultJson(summary: ValidationSummary, diagnostics: readonly Diagnostic[], workspace: boolean): ValidationResultJson {
	return {
		schema: 'ef/validation-result@1',
		kind: 'validation',
		scope: summary.scope,
		baseline_oid: summary.baselineOid,
		proposed_oid: summary.proposedOid,
		integration_ref: summary.integrationRef,
		expected_ref_oid: summary.expectedRefOid,
		strict: summary.strict,
		warnings_as_errors: summary.warningsAsErrors,
		workspace,
		complete: summary.complete,
		valid: summary.valid,
		counts: summary.counts,
		exit_code: summary.exitCode,
		diagnostics: diagnosticsToJson(diagnostics),
	}
}

// ---------------------------------------------------------------------------
// ef/mutation-result@1
// ---------------------------------------------------------------------------

export interface MutationChangeJson {
	action: 'create'
	path: string
}

export interface MutationResultJson {
	schema: 'ef/mutation-result@1'
	kind: 'init' | 'artifact-create'
	complete: boolean
	applied: boolean
	dry_run: boolean
	changes: MutationChangeJson[]
	artifact: ArtifactSummaryProjection | null
	diagnostics: ReturnType<typeof diagnosticsToJson>
}

export interface BuildMutationResultInput {
	kind: 'init' | 'artifact-create'
	complete: boolean
	applied: boolean
	dryRun: boolean
	changes: readonly MutationChangeJson[]
	artifact: ArtifactSummaryProjection | null
	diagnostics: readonly Diagnostic[]
}

export function buildMutationResultJson(input: BuildMutationResultInput): MutationResultJson {
	return {
		schema: 'ef/mutation-result@1',
		kind: input.kind,
		complete: input.complete,
		applied: input.applied,
		dry_run: input.dryRun,
		changes: [...input.changes].sort((a, b) => compareBytewise(a.path, b.path)),
		artifact: input.artifact,
		diagnostics: diagnosticsToJson(input.diagnostics),
	}
}

// ---------------------------------------------------------------------------
// ef/query-result@1 (already wire-shaped by the application layer; only the
// embedded `diagnostics` array needs conversion).
// ---------------------------------------------------------------------------

export function queryResultToJson(result: QueryResult): Record<string, unknown> {
	return { ...result, diagnostics: diagnosticsToJson(result.diagnostics) }
}

// ---------------------------------------------------------------------------
// ef/version-result@1
// ---------------------------------------------------------------------------

export interface VersionResultJson {
	schema: 'ef/version-result@1'
	version: string
	ef_core_major: 1
}

export function buildVersionResultJson(version: string): VersionResultJson {
	return { schema: 'ef/version-result@1', version, ef_core_major: 1 }
}

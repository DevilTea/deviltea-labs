/**
 * Human-mode result rendering (13-cli-contract.md "Human Output": "Human
 * output is designed for people and is not a machine contract. Wording,
 * spacing, and presentation may improve between compatible releases.").
 *
 * Nothing here is a stable contract; tests exercise only that output reflects
 * the underlying result (exit-relevant facts, diagnostic content), never
 * exact wording. Query results render as indented JSON in human mode too --
 * EF Core v1 defines eight structurally different query kinds and the
 * contract does not mandate a bespoke tabular view for each, so reusing the
 * already-serializable JSON envelope keeps human and machine views
 * consistent without inventing an uncontracted second rendering per kind.
 */

import type { JsonDiagnostic } from './diagnostics-json'
import type { MutationResultJson, ValidationResultJson } from './envelopes'

function color(useColor: boolean, code: string, text: string): string {
	return useColor ? `[${code}m${text}[0m` : text
}

function renderDiagnosticLine(diagnostic: JsonDiagnostic, useColor: boolean): string {
	const location = diagnostic.path
		? `${diagnostic.path}${diagnostic.location ? `:${diagnostic.location.line}:${diagnostic.location.column}` : ''}`
		: undefined
	const severityColor = diagnostic.severity === 'error' ? '31' : diagnostic.severity === 'warning' ? '33' : '36'
	const parts = [color(useColor, severityColor, `[${diagnostic.severity}]`), diagnostic.code, diagnostic.message]
	if (location)
		parts.push(`(${location})`)
	// Range scope's `commit_oid` attributes a finding to one commit of the
	// validated sequence; a short marker lets a human tell which commit a
	// range finding belongs to. Presentational only -- not a machine contract
	// (13-cli-contract.md "Human Output").
	if (diagnostic.commit_oid)
		parts.push(`@${diagnostic.commit_oid}`)
	return parts.join(' ')
}

function renderDiagnostics(diagnostics: readonly JsonDiagnostic[], useColor: boolean): string[] {
	if (diagnostics.length === 0)
		return []
	return ['', ...diagnostics.map(d => renderDiagnosticLine(d, useColor))]
}

export function renderValidationHuman(json: ValidationResultJson, useColor: boolean): string {
	const statusText = json.valid ? color(useColor, '32', 'valid') : color(useColor, '31', 'invalid')
	const completeness = json.complete ? 'complete' : 'incomplete'
	const lines = [
		`ef validate --scope ${json.scope}: ${statusText} (${completeness})`,
		`errors=${json.counts.error} warnings=${json.counts.warning} info=${json.counts.info}`,
		...renderDiagnostics(json.diagnostics, useColor),
	]
	return `${lines.join('\n')}\n`
}

export function renderMutationHuman(json: MutationResultJson, useColor: boolean): string {
	const statusText = json.applied
		? color(useColor, '32', 'applied')
		: json.dry_run
			? color(useColor, '36', 'planned (dry run)')
			: color(useColor, '33', 'not applied')
	const lines = [
		`ef ${json.kind}: ${statusText}`,
		...json.changes.map(change => `  ${change.action} ${change.path}`),
		...renderDiagnostics(json.diagnostics, useColor),
	]
	return `${lines.join('\n')}\n`
}

export function renderQueryHuman(json: Record<string, unknown>): string {
	return `${JSON.stringify(json, null, 2)}\n`
}

export function renderVersionHuman(version: string): string {
	return `ef ${version}\n`
}

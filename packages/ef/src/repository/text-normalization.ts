/**
 * Text and path normalization findings (11-filesystem-and-config.md "Text
 * and Path Normalization").
 *
 * `checkTextNormalization` turns the byte-level findings from
 * `platform/text-checks.ts` into `EF-FS-005` diagnostics for one authoritative
 * text file (`.engineering/ef.yaml`, `.engineering/.gitignore`, or an
 * Artifact file). `checkPathNormalization` reports `EF-FS-006` when a managed
 * path is not itself Unicode-NFC-normalized, or when a declared/serialized
 * path does not exactly (including case) match the corresponding path
 * discovered through a case-preserving directory listing -- the case where a
 * case-insensitive filesystem would otherwise silently resolve a
 * wrong-case reference. Both functions are pure logic; they perform no
 * filesystem access themselves.
 */

import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic } from '../domain/diagnostics'
import type { BytePosition } from '../platform/text-checks'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { detectBom, detectCrlf, detectInvalidUtf8, detectMissingFinalNewline } from '../platform/text-checks'

function makeDiagnostic(code: DiagnosticCode, message: string, path: string, field: string, byte?: BytePosition): Diagnostic {
	return {
		code,
		severity: severityOf(code),
		message,
		path,
		field,
		location: byte ? { line: byte.line, column: 1 } : undefined,
		related: [],
	}
}

/**
 * Report `EF-FS-005` for every UTF-8, LF, BOM, or final-newline violation
 * found in one authoritative text file's raw bytes. Every CRLF occurrence is
 * reported independently, since each is a separately actionable line-ending
 * violation. Each violation kind uses a distinct `field` disambiguator
 * (`bom`, `utf8`, `crlf[<offset>]`, `final-newline`) so that, for example, a
 * BOM and a CRLF finding on the same reported line are never collapsed by
 * `aggregateDiagnostics`'s location-based deduplication.
 */
export function checkTextNormalization(path: string, bytes: Uint8Array): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	const bom = detectBom(bytes)
	if (bom)
		diagnostics.push(makeDiagnostic('EF-FS-005', `Authoritative text file '${path}' begins with a forbidden UTF-8 byte-order mark.`, path, 'bom', bom))

	const invalidUtf8 = detectInvalidUtf8(bytes)
	if (invalidUtf8)
		diagnostics.push(makeDiagnostic('EF-FS-005', `Authoritative text file '${path}' contains invalid UTF-8 at byte offset ${invalidUtf8.offset}.`, path, 'utf8', invalidUtf8))

	for (const crlf of detectCrlf(bytes))
		diagnostics.push(makeDiagnostic('EF-FS-005', `Authoritative text file '${path}' contains a CRLF line ending; only LF is permitted.`, path, `crlf[${crlf.offset}]`, crlf))

	const missingFinalNewline = detectMissingFinalNewline(bytes)
	if (missingFinalNewline)
		diagnostics.push(makeDiagnostic('EF-FS-005', `Authoritative text file '${path}' does not end with exactly one final newline.`, path, 'final-newline', missingFinalNewline))

	return aggregateDiagnostics(diagnostics)
}

export interface PathNormalizationEntry {
	/** Project-relative path text as declared, serialized, or otherwise expected. */
	path: string
	/**
	 * The exact path text discovered through a case-preserving directory
	 * listing (e.g. `walkDirectory`'s `relativePath`), when a cross-reference
	 * exists to compare against. Omit when `path` is itself the only
	 * available observation (its own NFC-normalization is still checked).
	 */
	actualPath?: string
}

/**
 * Report `EF-FS-006` for a managed path that is not Unicode-NFC-normalized,
 * or -- once NFC-normalized -- that does not exactly (including case) match
 * its corresponding on-disk entry.
 */
export function checkPathNormalization(entries: readonly PathNormalizationEntry[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = []

	for (const entry of entries) {
		const nfc = entry.path.normalize('NFC')
		if (entry.path !== nfc) {
			diagnostics.push(makeDiagnostic('EF-FS-006', `Managed path '${entry.path}' is not in Unicode NFC normalized form.`, entry.path, 'nfc'))
			continue
		}

		if (entry.actualPath !== undefined && entry.actualPath !== entry.path)
			diagnostics.push(makeDiagnostic('EF-FS-006', `Managed path '${entry.path}' does not exactly match the on-disk entry '${entry.actualPath}'.`, entry.path, 'case'))
	}

	return aggregateDiagnostics(diagnostics)
}

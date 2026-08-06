/**
 * Artifact discovery scope and canonical layout membership
 * (11-filesystem-and-config.md "Canonical Layout" / "Artifact discovery
 * scope").
 *
 * `listArtifactFiles` is pure logic over a caller-supplied flat listing of
 * every entry beneath `.engineering` (normally produced by
 * `platform/fs-facts.ts`'s `walkDirectory(path.join(projectRoot,
 * '.engineering'))`); it performs no filesystem access itself. It classifies
 * every entry as: the PROJECT control file, another control file, a
 * directly-nested `*.md` Artifact file inside one of the five canonical
 * type directories, a path beneath the managed Resource root or a
 * conventional runtime path (both out of this module's reporting scope), or
 * an entry that violates the canonical layout (`EF-FS-003`).
 *
 * Wrong-type canonical Artifact placement (`EF-ID-014`) and unowned managed
 * Resource files (`EF-RES-015`) are owned by other namespaces and are never
 * reported here, per the precedence rules in 11-filesystem-and-config.md.
 */

import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic } from '../domain/diagnostics'
import type { WalkEntry } from '../platform/fs-facts'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { compareBytewise } from '../domain/model'

const CONTROL_FILE_NAMES: ReadonlySet<string> = new Set(['ef.yaml', '.gitignore'])
const CANONICAL_ARTIFACT_DIR_NAMES: ReadonlySet<string> = new Set(['prd', 'req', 'adr', 'pol', 'chg'])
const RUNTIME_DIR_NAMES: ReadonlySet<string> = new Set(['.cache', '.generated', '.tmp'])
const RUNTIME_FILE_NAMES: ReadonlySet<string> = new Set(['.lock'])
const MANAGED_RESOURCE_ROOT_NAME = 'resources'

export interface ListArtifactFilesResult {
	/** Project-relative canonical Artifact paths, bytewise sorted. */
	artifactFiles: string[]
	/** `EF-FS-003` findings for entries that violate the canonical layout. */
	diagnostics: Diagnostic[]
}

function makeDiagnostic(code: DiagnosticCode, message: string, path: string): Diagnostic {
	return { code, severity: severityOf(code), message, path, related: [] }
}

/**
 * Classify every entry beneath `.engineering` per the Artifact discovery
 * scope. `entries` are relative to `.engineering` itself (not the project
 * root), using `/` separators, as produced by `walkDirectory`.
 */
export function listArtifactFiles(entries: readonly WalkEntry[]): ListArtifactFilesResult {
	const artifactFiles: string[] = []
	const diagnostics: Diagnostic[] = []
	const suppressedPrefixes: string[] = []

	function isSuppressed(relativePath: string): boolean {
		return suppressedPrefixes.some(prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`))
	}

	function reportUnexpected(relativePath: string, isDirectory: boolean): void {
		diagnostics.push(makeDiagnostic('EF-FS-003', `Entry '.engineering/${relativePath}' violates the canonical EF layout.`, `.engineering/${relativePath}`))
		if (isDirectory)
			suppressedPrefixes.push(relativePath)
	}

	for (const entry of entries) {
		if (isSuppressed(entry.relativePath))
			continue

		const segments = entry.relativePath.split('/')

		if (segments.length === 1) {
			const name = segments[0]!

			if (name === 'PROJECT.md') {
				if (entry.isRegularFile)
					artifactFiles.push('.engineering/PROJECT.md')
				continue
			}

			if (CONTROL_FILE_NAMES.has(name))
				continue

			if (RUNTIME_FILE_NAMES.has(name))
				continue

			if (RUNTIME_DIR_NAMES.has(name)) {
				if (entry.isDirectory) {
					suppressedPrefixes.push(name)
					continue
				}
				reportUnexpected(name, entry.isDirectory)
				continue
			}

			if (name === MANAGED_RESOURCE_ROOT_NAME) {
				if (entry.isDirectory) {
					suppressedPrefixes.push(name)
					continue
				}
				reportUnexpected(name, entry.isDirectory)
				continue
			}

			if (CANONICAL_ARTIFACT_DIR_NAMES.has(name)) {
				if (entry.isDirectory)
					continue
				reportUnexpected(name, entry.isDirectory)
				continue
			}

			reportUnexpected(name, entry.isDirectory)
			continue
		}

		if (segments.length === 2 && CANONICAL_ARTIFACT_DIR_NAMES.has(segments[0]!)) {
			const dir = segments[0]!
			const name = segments[1]!

			if (entry.isRegularFile && name.endsWith('.md')) {
				artifactFiles.push(`.engineering/${dir}/${name}`)
				continue
			}

			reportUnexpected(`${dir}/${name}`, entry.isDirectory)
			continue
		}

		// Defensive: a caller-supplied listing that is not a literal recursive
		// walk (e.g. a synthetic deep path whose ancestor was not itself listed)
		// still gets reported rather than silently accepted.
		reportUnexpected(entry.relativePath, entry.isDirectory)
	}

	artifactFiles.sort(compareBytewise)

	return { artifactFiles, diagnostics: aggregateDiagnostics(diagnostics) }
}

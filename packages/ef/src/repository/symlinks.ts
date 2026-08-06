/**
 * Managed symlink policy (11-filesystem-and-config.md "Text and Path
 * Normalization" symlink policy, `EF-FS-004`).
 *
 * Symlinks are forbidden for `.engineering` and its canonical directories,
 * `.engineering/ef.yaml`/`.engineering/.gitignore`, every Artifact file,
 * every local Resource file and its directory path components, and (only
 * during workspace validation or discovery association) configured linked
 * repository paths and their existing path components.
 *
 * This module is pure logic: `managedSymlinkPaths` computes exactly which
 * project-relative paths must be checked (including every existing directory
 * component of a Resource or linked-repository path), and
 * `checkManagedSymlinks` turns caller-supplied per-path symlink facts (from
 * `platform/fs-facts.ts`'s `isSymlink`) into `EF-FS-004` diagnostics. Neither
 * function performs filesystem access itself.
 */

import type { DiagnosticCode } from '../domain/diagnostic-codes'
import type { Diagnostic } from '../domain/diagnostics'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { compareBytewise } from '../domain/model'

/** `.engineering` itself, its fixed canonical directories, and its two control files. */
export const FIXED_MANAGED_PATHS: readonly string[] = [
	'.engineering',
	'.engineering/prd',
	'.engineering/req',
	'.engineering/adr',
	'.engineering/pol',
	'.engineering/chg',
	'.engineering/resources',
	'.engineering/ef.yaml',
	'.engineering/.gitignore',
]

/** Every prefix of `path`, from its first segment up to the complete path (e.g. `a/b/c` -> `['a', 'a/b', 'a/b/c']`). */
export function pathComponents(path: string): string[] {
	const segments = path.split('/')
	const components: string[] = []
	let current = ''
	for (const segment of segments) {
		current = current.length > 0 ? `${current}/${segment}` : segment
		components.push(current)
	}
	return components
}

export interface ManagedSymlinkScopeInput {
	/** Project-relative Artifact file paths, e.g. from `listArtifactFiles` (includes `.engineering/PROJECT.md`). */
	artifactFiles: readonly string[]
	/** Project-relative local Resource file paths (each descriptor's `location`). */
	resourceFiles: readonly string[]
	/** Configured linked repository paths; include only during workspace validation or discovery association. */
	linkedRepositoryPaths?: readonly string[]
}

/**
 * Every project-relative path whose symlink status must be checked
 * (`EF-FS-004`), bytewise sorted and deduplicated: the fixed managed paths,
 * every Artifact file, every Resource file together with its existing
 * directory path components, and -- only when supplied -- every linked
 * repository path together with its existing path components.
 */
export function managedSymlinkPaths(input: ManagedSymlinkScopeInput): string[] {
	const paths = new Set<string>(FIXED_MANAGED_PATHS)

	for (const file of input.artifactFiles)
		paths.add(file)

	for (const file of input.resourceFiles) {
		for (const component of pathComponents(file))
			paths.add(component)
	}

	for (const repoPath of input.linkedRepositoryPaths ?? []) {
		for (const component of pathComponents(repoPath))
			paths.add(component)
	}

	return [...paths].sort(compareBytewise)
}

export interface SymlinkFact {
	path: string
	isSymlink: boolean
}

function makeDiagnostic(code: DiagnosticCode, message: string, path: string): Diagnostic {
	return { code, severity: severityOf(code), message, path, related: [] }
}

/** Report `EF-FS-004` for every managed path fact whose `isSymlink` is `true`. */
export function checkManagedSymlinks(facts: readonly SymlinkFact[]): Diagnostic[] {
	const diagnostics = facts
		.filter(fact => fact.isSymlink)
		.map(fact => makeDiagnostic('EF-FS-004', `Managed path '${fact.path}' is a forbidden symlink.`, fact.path))
	return aggregateDiagnostics(diagnostics)
}

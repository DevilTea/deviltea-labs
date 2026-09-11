/**
 * Workspace validation (11-filesystem-and-config.md "Workspace validation"):
 * every linked repository with `required: true` exists, each present linked
 * path is an independent Git worktree whose root matches the configured path
 * exactly, and each present configured path and its existing path components
 * are not symlinks (`EF-FS-004`).
 *
 * This module owns the domain decision of which findings to report; it does
 * not itself touch the filesystem or spawn Git. Both filesystem existence and
 * the Git worktree-association question are injected, so tests can supply a
 * fake for isolated cases and a real Git-backed implementation for
 * integration cases (00-implementation-decisions.md "inject the git
 * interface so tests can pass a fake where real git is unnecessary").
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { LinkedRepositoryDescriptor } from './config'
import { severityOf } from '../domain/diagnostic-codes'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { checkManagedSymlinks, pathComponents } from './symlinks'

export interface WorkspacePathFacts {
	/** Whether the configured path exists on disk, of any type. */
	exists: boolean
	isSymlink: boolean
}

export type WorktreeAssociationResult
	= | { kind: 'matches' }
		| { kind: 'mismatched-root', actualRoot: string }
		| { kind: 'not-a-worktree' }
		| { kind: 'git-unavailable', message: string }

export interface ValidateWorkspaceDeps {
	/** Filesystem existence/symlink facts for a project-relative path. */
	pathFacts: (relativePath: string) => Promise<WorkspacePathFacts> | WorkspacePathFacts
	/** Whether the independent Git worktree containing `relativePath` (project-relative) has its root exactly at `relativePath`. */
	checkWorktreeAssociation: (relativePath: string) => Promise<WorktreeAssociationResult> | WorktreeAssociationResult
}

export interface ValidateWorkspaceInput {
	linkedRepositories: readonly LinkedRepositoryDescriptor[]
}

export interface ValidateWorkspaceResult {
	diagnostics: Diagnostic[]
	/**
	 * `false` when Git or filesystem capability was unavailable for at least
	 * one present linked repository, so its worktree-association check could
	 * not be answered. The caller maps this to its own execution-completeness
	 * diagnostic (e.g. `EF-VAL-006`) rather than this module inventing one.
	 */
	complete: boolean
}

function makeDiagnostic(code: 'EF-FS-007' | 'EF-FS-008', message: string, field: string): Diagnostic {
	return { code, severity: severityOf(code), message, field, related: [] }
}

/**
 * Validate composite-workspace facts for every configured linked repository:
 * required-presence (`EF-FS-007`), independent-worktree-at-configured-root
 * (`EF-FS-008`), and the managed symlink policy (`EF-FS-004`) over the
 * configured path and its existing path components.
 */
export async function validateWorkspace(input: ValidateWorkspaceInput, deps: ValidateWorkspaceDeps): Promise<ValidateWorkspaceResult> {
	const diagnostics: Diagnostic[] = []
	let complete = true

	for (const descriptor of input.linkedRepositories) {
		const facts = await deps.pathFacts(descriptor.path)

		if (!facts.exists) {
			if (descriptor.required) {
				diagnostics.push(makeDiagnostic(
					'EF-FS-007',
					`Required linked repository '${descriptor.id}' at '${descriptor.path}' is missing.`,
					`linked_repositories[${descriptor.id}]`,
				))
			}
			continue
		}

		const symlinkFacts = await Promise.all(pathComponents(descriptor.path)
			.map(async (component) => {
				const componentFacts = component === descriptor.path ? facts : await deps.pathFacts(component)
				return { path: component, isSymlink: componentFacts.isSymlink }
			}))
		diagnostics.push(...checkManagedSymlinks(symlinkFacts))

		const association = await deps.checkWorktreeAssociation(descriptor.path)
		if (association.kind === 'git-unavailable') {
			complete = false
			continue
		}
		if (association.kind !== 'matches') {
			diagnostics.push(makeDiagnostic(
				'EF-FS-008',
				`Present linked repository '${descriptor.id}' at '${descriptor.path}' is not an independent Git worktree at its configured root.`,
				`linked_repositories[${descriptor.id}]`,
			))
		}
	}

	return { diagnostics: aggregateDiagnostics(diagnostics), complete }
}

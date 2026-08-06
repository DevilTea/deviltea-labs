/**
 * CLI-level project resolution (13-cli-contract.md "Common Options" `--project`;
 * 11-filesystem-and-config.md "Project Discovery").
 *
 * Wraps `repository/discovery.ts`'s `discoverProject` with a real Git
 * executor bound lazily (via the standalone `findWorktreeRoot(executor,
 * path)`, which needs no project root of its own) and exposes the result as
 * a small discriminated union the command layer maps directly onto its own
 * exit-code table. `git-unavailable` is threaded straight from discovery.
 * A discovered-but-schema-invalid configuration is deliberately NOT a
 * resolution failure here (09-validation.md: "A discovered and readable but
 * schema-invalid configuration is a domain finding and uses exit 1"): the
 * caller re-decodes configuration itself via `loadSnapshotFromWorkingTree`,
 * which folds that finding into its own diagnostics.
 */

import type { GitExecutor } from '../git/executor'
import type { GitRepository } from '../git/repository'
import type { Config } from '../repository/config'
import path from 'pathe'
import { createGitExecutor } from '../git/executor'
import { createGitRepository, findWorktreeRoot } from '../git/repository'
import { discoverProject } from '../repository/discovery'

export interface ProjectContext {
	root: string
	config: Config | null
	git: GitRepository
}

export type ResolveProjectFailureReason
	= | 'not-found'
		| 'not-a-directory'
		| 'incomplete-initialization'
		| 'not-project-worktree-root'
		| 'unassociated'
		| 'read-error'
		| 'git-unavailable'

export type ResolveProjectResult
	= | { ok: true, context: ProjectContext }
		| { ok: false, reason: ResolveProjectFailureReason, message: string, root?: string }

export interface ResolveProjectInput {
	cwd: string
	/** The raw `--project` option value, resolved against `cwd` when relative. */
	explicitProject?: string
}

/** Real filesystem/Git-backed dependency; injectable for tests. */
export function createDefaultGitExecutor(): GitExecutor {
	return createGitExecutor()
}

export async function resolveProject(input: ResolveProjectInput, executor: GitExecutor = createDefaultGitExecutor()): Promise<ResolveProjectResult> {
	const explicitRoot = input.explicitProject !== undefined ? path.resolve(input.cwd, input.explicitProject) : undefined

	const result = await discoverProject(
		{ cwd: input.cwd, explicitRoot },
		{ findWorktreeRoot: absolutePath => findWorktreeRoot(executor, absolutePath) },
	)

	switch (result.kind) {
		case 'resolved':
			return { ok: true, context: { root: result.root, config: result.config, git: createGitRepository(result.root, executor) } }
		case 'not-found':
			return { ok: false, reason: 'not-found', message: 'No EF project (\'.engineering\') was found.' }
		case 'not-a-directory':
			return { ok: false, reason: 'not-a-directory', message: `'${result.path}' exists but is not a directory.` }
		case 'incomplete-initialization':
			return { ok: false, reason: 'incomplete-initialization', message: 'An incomplete working-tree initialization was discovered.', root: result.root }
		case 'not-project-worktree-root':
			return { ok: false, reason: 'not-project-worktree-root', message: `'${result.root}' is not the Git worktree root that directly contains '.engineering'.`, root: result.root }
		case 'unassociated':
			return { ok: false, reason: 'unassociated', message: 'The current working directory is not associated with the discovered EF project.', root: result.root }
		case 'read-error':
			return { ok: false, reason: 'read-error', message: result.message, root: result.root }
		case 'git-unavailable':
			return { ok: false, reason: 'git-unavailable', message: result.message }
	}
}

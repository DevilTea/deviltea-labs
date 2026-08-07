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
import type { FileIdentity } from '../platform/fs-facts'
import type { Config } from '../repository/config'
import path from 'pathe'
import { createGitExecutor } from '../git/executor'
import { createGitRepository, findWorktreeRoot } from '../git/repository'
import { isSameLocation } from '../platform/path-identity'
import { discoverProject } from '../repository/discovery'

export interface ProjectContext {
	root: string
	/**
	 * Configuration decoded from discovery's OWN, separate read of
	 * `.engineering/ef.yaml` (performed to decide discovery outcomes:
	 * incomplete-initialization, working-directory association, and so on).
	 * This is deliberately NOT a general-purpose config accessor for command
	 * semantics (Finding 3, "single observation"): `.engineering/ef.yaml` can
	 * be rewritten in place between this read and any later, separate read a
	 * command performs (e.g. `loadSnapshotFromWorkingTree`'s own), so a
	 * command that mixed this value with a later snapshot's config could
	 * derive different semantics (an integration ref, a linked-repositories
	 * list) from two different observations of the same file. A command that
	 * also loads a `ProjectSnapshot` MUST derive every config-dependent
	 * semantic from that snapshot's own `config.config` instead, never from
	 * this field (see `query.ts`/`validate.ts`'s snapshot-scope handling).
	 */
	config: Config | null
	/**
	 * `.engineering`'s identity as observed by THIS discovery (Finding 4,
	 * "single observation"), for binding a later, separate directory walk
	 * (`application/snapshot.ts`'s `loadSnapshotFromWorkingTree`) to the exact
	 * directory this discovery approved -- see that field's own doc on
	 * `repository/discovery.ts`'s `DiscoverProjectResult`.
	 */
	engineeringIdentity: FileIdentity
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
			return { ok: true, context: { root: result.root, config: result.config, engineeringIdentity: result.engineeringIdentity, git: createGitRepository(result.root, executor) } }
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

// ---------------------------------------------------------------------------
// Commit-bound project resolution (transition/bootstrap `--project`)
// ---------------------------------------------------------------------------

export interface CommitBoundProjectContext {
	root: string
	git: GitRepository
}

export type ResolveCommitBoundProjectFailureReason = 'not-project-worktree-root' | 'git-unavailable'

export type ResolveCommitBoundProjectResult
	= | { ok: true, context: CommitBoundProjectContext }
		| { ok: false, reason: ResolveCommitBoundProjectFailureReason, message: string }

export interface ResolveCommitBoundProjectInput {
	cwd: string
	/** The raw `--project` option value, resolved against `cwd` when relative. Required: this path has no meaning for implicit discovery. */
	explicitProject: string
}

/**
 * Resolve an explicit `--project` root for commit-bound transition/bootstrap
 * validation (11-filesystem-and-config.md "Project Discovery": "For
 * commit-bound transition or bootstrap validation, an explicit `--project`
 * identifies the project Git worktree root even when its checked-out tree
 * does not contain the candidate configuration. The validator loads
 * authoritative configuration from the supplied commit or commits.").
 *
 * Unlike `resolveProject`, this performs no working-tree `.engineering`/
 * `ef.yaml` discovery and does not classify a config-less working tree as an
 * incomplete initialization: the caller loads authoritative configuration
 * from the supplied commit(s) instead (`peekConfigAt` in
 * `../cli/commands/validate.ts`). It verifies only that `explicitProject` is
 * exactly the Git worktree root -- "this exception allows bootstrap
 * validation from a pre-EF checkout when the repository root is explicit."
 */
export async function resolveCommitBoundProject(input: ResolveCommitBoundProjectInput, executor: GitExecutor = createDefaultGitExecutor()): Promise<ResolveCommitBoundProjectResult> {
	const root = path.resolve(input.cwd, input.explicitProject)

	const worktree = await findWorktreeRoot(executor, root)
	if (worktree.kind === 'git-unavailable')
		return { ok: false, reason: 'git-unavailable', message: worktree.message }
	if (worktree.kind === 'not-a-worktree' || !isSameLocation(worktree.root, root))
		return { ok: false, reason: 'not-project-worktree-root', message: `'${root}' is not the Git worktree root.` }

	return { ok: true, context: { root, git: createGitRepository(root, executor) } }
}

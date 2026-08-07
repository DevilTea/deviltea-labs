/**
 * Shared working-tree resolution + snapshot loading for CLI commands that
 * operate against the current, discovered EF project (`query`, `validate`'s
 * `snapshot` scope, `artifact create`, `resource read`).
 *
 * Consolidates three steps every one of those commands must perform
 * identically (eighth-round Findings 9-12, "these commands cannot drift
 * again"):
 *
 *  1. Project resolution (`./project-context.ts`'s `resolveProject`).
 *  2. Loading the `ProjectSnapshot`, bound to discovery's OWN `.engineering`
 *     identity observation (Finding 4, "single observation" -- see
 *     `application/snapshot.ts`'s `LoadSnapshotFromWorkingTreeOptions.expectedEngineeringIdentity`),
 *     so a directory-replacement race landing between discovery and this
 *     later, separate walk (e.g. one that omits an Artifact or a second
 *     Resource owner) is refused as `engineering-swapped` rather than
 *     silently producing a snapshot over the wrong directory.
 *  3. Re-running the working-directory association decision
 *     (`repository/discovery.ts`'s `checkWorkingDirectoryAssociation`)
 *     against `config` -- the snapshot's own, freshest read of
 *     `.engineering/ef.yaml` -- rather than trusting `resolveProject`'s
 *     separate, earlier read, which an in-place rewrite could have made
 *     stale by the time the snapshot finished loading (Finding 5, "single
 *     observation").
 *
 * Step 3 is skipped entirely for an EXPLICIT `--project`
 * (11-filesystem-and-config.md "Project Discovery": association is only
 * ever validated "for implicit (non-explicit) discovery" -- an
 * otherwise-rejected nested worktree can supply another explicit project
 * root instead, and re-imposing the invocation-CWD requirement after
 * explicit resolution would defeat that exception).
 *
 * Every failure is returned as a typed, staged result rather than a single
 * flattened reason: each of the four callers already had its OWN diagnostic
 * mapping for "project resolution failed" versus "the snapshot itself failed
 * to load," and Finding 10 additionally requires the association-recheck
 * failure to use a DIFFERENT diagnostic identity than
 * `resolveProject`'s own `'incomplete-initialization'` reason uses (the
 * generic invocation/resolution class, not `EF-VAL-012`, which is
 * registry-owned by "an incomplete working-tree initialization claim
 * exists"). Preserving the stage lets every caller keep mapping each one
 * exactly as before.
 */

import type { LoadSnapshotFailureReason, ProjectSnapshot } from '../application/snapshot'
import type { SnapshotValidationResult } from '../application/snapshot-validation'
import type { GitExecutor } from '../git/executor'
import type { GitRepository } from '../git/repository'
import type { Config } from '../repository/config'
import type { ResolveProjectFailureReason } from './project-context'
import { loadSnapshotFromWorkingTree } from '../application/snapshot'
import { validateSnapshot } from '../application/snapshot-validation'
import { findWorktreeRoot } from '../git/repository'
import { checkWorkingDirectoryAssociation } from '../repository/discovery'
import { createDefaultGitExecutor, resolveProject } from './project-context'

export interface WorkingTreeContext {
	root: string
	git: GitRepository
	snapshot: ProjectSnapshot
	validation: SnapshotValidationResult
	/**
	 * The single, freshest configuration observation -- `snapshot.config.config`
	 * -- never `resolveProject`'s own, earlier discovery read (Finding 3,
	 * "single observation"). Every config-dependent semantic downstream MUST
	 * derive from this field alone.
	 */
	config: Config | null
}

export interface LoadWorkingTreeContextInput {
	cwd: string
	/** The raw `--project` option value, resolved against `cwd` when relative. */
	explicitProject?: string
}

export type LoadWorkingTreeContextResult
	= | { ok: true, context: WorkingTreeContext }
		/** `resolveProject` itself failed: no `.engineering` found, an incomplete initialization, a non-worktree-root candidate, and so on. */
		| { ok: false, stage: 'resolve', reason: ResolveProjectFailureReason, message: string }
		/** Project resolution succeeded, but `loadSnapshotFromWorkingTree` itself failed (including `engineering-swapped`, a directory-identity race caught by threading discovery's own `.engineering` observation into this load). */
		| { ok: false, stage: 'load', reason: LoadSnapshotFailureReason, message: string }
		/**
		 * The working-directory association re-check (implicit discovery only)
		 * did not confirm association against the snapshot's own, freshest
		 * configuration. `reason: 'unassociated'` is deliberately NOT the same
		 * diagnostic identity `resolveProject`'s own `'incomplete-initialization'`
		 * reason uses (Finding 10): callers must map it to the generic
		 * invocation/resolution class, exactly as `resolveProject`'s own
		 * `'unassociated'` reason already is.
		 */
		| { ok: false, stage: 'association', reason: 'unassociated' | 'git-unavailable', message: string }

/**
 * Resolve the project, load its snapshot bound to discovery's own
 * `.engineering` identity, and -- for implicit discovery only -- re-check
 * working-directory association against the snapshot's own freshest
 * configuration. See this module's doc for the full rationale.
 */
export async function loadWorkingTreeContext(input: LoadWorkingTreeContextInput, executor: GitExecutor = createDefaultGitExecutor()): Promise<LoadWorkingTreeContextResult> {
	const resolved = await resolveProject({ cwd: input.cwd, explicitProject: input.explicitProject }, executor)
	if (!resolved.ok)
		return { ok: false, stage: 'resolve', reason: resolved.reason, message: resolved.message }

	const { root, git, engineeringIdentity } = resolved.context

	const loaded = await loadSnapshotFromWorkingTree(root, undefined, { expectedEngineeringIdentity: engineeringIdentity })
	if (!loaded.ok)
		return { ok: false, stage: 'load', reason: loaded.reason, message: loaded.message }

	const config = loaded.snapshot.config.config

	// Explicit `--project` is exempt from association re-checking (see this
	// module's doc): `resolveProject`/`discoverProject` never validated
	// association for it in the first place, so there is no prior decision to
	// keep fresh here either.
	if (input.explicitProject !== undefined) {
		const validation = validateSnapshot(loaded.snapshot)
		return { ok: true, context: { root, git, snapshot: loaded.snapshot, validation, config } }
	}

	const association = await checkWorkingDirectoryAssociation(
		{ cwd: input.cwd, candidateRoot: root, config },
		{ findWorktreeRoot: absolutePath => findWorktreeRoot(executor, absolutePath) },
	)
	if (association.kind === 'unassociated') {
		return {
			ok: false,
			stage: 'association',
			reason: 'unassociated',
			message: `The current working directory is no longer associated with the discovered EF project at '${root}': its configuration was rewritten and no longer declares this working directory's worktree as the project's own or as a linked repository.`,
		}
	}
	if (association.kind === 'git-unavailable') {
		return {
			ok: false,
			stage: 'association',
			reason: 'git-unavailable',
			message: `Git is unavailable while re-checking working-directory association: ${association.message}`,
		}
	}

	const validation = validateSnapshot(loaded.snapshot)
	return { ok: true, context: { root, git, snapshot: loaded.snapshot, validation, config } }
}

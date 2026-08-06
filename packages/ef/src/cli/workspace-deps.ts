/**
 * Real filesystem/Git-backed dependencies for `repository/workspace.ts`'s
 * `validateWorkspace`, bound to one concrete project root
 * (11-filesystem-and-config.md "Workspace validation").
 */

import type { GitExecutor } from '../git/executor'
import type { ValidateWorkspaceDeps } from '../repository/workspace'
import path from 'pathe'
import { findWorktreeRoot } from '../git/repository'
import { isDirectory, isRegularFile, isSymlink } from '../platform/fs-facts'

export function createWorkspaceDeps(root: string, executor: GitExecutor): ValidateWorkspaceDeps {
	return {
		pathFacts: async (relativePath: string) => {
			const absolute = path.join(root, relativePath)
			const [symlink, directory, regularFile] = await Promise.all([isSymlink(absolute), isDirectory(absolute), isRegularFile(absolute)])
			return { exists: symlink || directory || regularFile, isSymlink: symlink }
		},
		checkWorktreeAssociation: async (relativePath: string) => {
			const absolute = path.join(root, relativePath)
			const result = await findWorktreeRoot(executor, absolute)
			if (result.kind === 'git-unavailable')
				return result
			if (result.kind === 'not-a-worktree')
				return { kind: 'not-a-worktree' }
			return result.root === absolute ? { kind: 'matches' } : { kind: 'mismatched-root', actualRoot: result.root }
		},
	}
}

/**
 * Project discovery (11-filesystem-and-config.md "Project Discovery").
 *
 * Implements the exact six-step order: an explicit project root wins over
 * search; otherwise ascend from the working directory looking for
 * `.engineering`, never stopping at an intervening Git worktree boundary;
 * select the nearest `.engineering` path even when its `ef.yaml` is absent;
 * classify a directory lacking `ef.yaml`, or one containing
 * `.tmp/init-state.json`, as an incomplete working-tree initialization
 * (a typed result -- the caller maps it to `EF-VAL-012` for validation and
 * mutation, or `EF-QRY-013` for query, per each command's diagnostic
 * ownership); reject a non-directory `.engineering`; verify that the
 * candidate root is exactly the Git worktree root that directly contains
 * `.engineering`; then load configuration and, for implicit (non-explicit)
 * discovery, validate working-directory association with the project.
 *
 * The Git worktree-root query is injected (`DiscoverProjectDeps`) so tests
 * can supply a fake where real Git is unnecessary, and a real Git-backed
 * implementation for integration cases.
 */

import type { Buffer } from 'node:buffer'
import type { Diagnostic } from '../domain/diagnostics'
import type { WorktreeRootResult } from '../git/repository'
import type { Config } from './config'
import { lstat, readFile } from 'node:fs/promises'
import path from 'pathe'
import { isDirectory } from '../platform/fs-facts'
import { decodeConfig } from './config'

export interface DiscoverProjectInput {
	/** The current working directory (absolute path). */
	cwd: string
	/** An explicitly supplied project root (absolute path); wins over search when present. */
	explicitRoot?: string
}

export interface DiscoverProjectDeps {
	/** Resolve the Git worktree root that contains `absolutePath` ("rev-parse --show-toplevel" semantics). */
	findWorktreeRoot: (absolutePath: string) => Promise<WorktreeRootResult>
}

export type DiscoverProjectResult
	= | { kind: 'resolved', root: string, config: Config | null, configDiagnostics: Diagnostic[] }
		/** No `.engineering` path was found ascending from `cwd` to the filesystem root. */
		| { kind: 'not-found' }
		/** An `.engineering` path exists but is not a directory (cannot be an initialization claim). */
		| { kind: 'not-a-directory', path: string }
		/** A directory `.engineering` lacks `ef.yaml`, or contains `.tmp/init-state.json`: an incomplete working-tree initialization claim. */
		| { kind: 'incomplete-initialization', root: string }
		/** The candidate root is not itself the Git worktree root that directly contains `.engineering`. */
		| { kind: 'not-project-worktree-root', root: string }
		/** The working directory is inside an undeclared nested Git worktree, or otherwise not associated with the discovered project (implicit discovery only). */
		| { kind: 'unassociated', root: string }
		/** `ef.yaml` exists but could not be read (e.g. a permission failure, or it is itself a directory). */
		| { kind: 'read-error', root: string, message: string }
		| { kind: 'git-unavailable', message: string }

async function pathExists(target: string): Promise<boolean> {
	try {
		await lstat(target)
		return true
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return false
		throw error
	}
}

/** Ascend from `startDir` (inclusive) to the filesystem root, returning the first directory that directly contains an `.engineering` path. */
async function ascendForEngineering(startDir: string): Promise<string | undefined> {
	let current = startDir
	while (true) {
		if (await pathExists(path.join(current, '.engineering')))
			return current
		const parent = path.dirname(current)
		if (parent === current)
			return undefined
		current = parent
	}
}

function decodeUtf8(bytes: Buffer): string {
	return new TextDecoder('utf-8', { fatal: false })
		.decode(bytes)
}

export async function discoverProject(input: DiscoverProjectInput, deps: DiscoverProjectDeps): Promise<DiscoverProjectResult> {
	const isExplicit = input.explicitRoot !== undefined

	let candidateRoot: string
	if (isExplicit) {
		candidateRoot = input.explicitRoot!
		if (!(await pathExists(path.join(candidateRoot, '.engineering'))))
			return { kind: 'not-found' }
	}
	else {
		const ascended = await ascendForEngineering(input.cwd)
		if (ascended === undefined)
			return { kind: 'not-found' }
		candidateRoot = ascended
	}

	const engineeringPath = path.join(candidateRoot, '.engineering')

	if (!(await isDirectory(engineeringPath)))
		return { kind: 'not-a-directory', path: engineeringPath }

	const efYamlPath = path.join(engineeringPath, 'ef.yaml')
	const initMarkerPath = path.join(engineeringPath, '.tmp', 'init-state.json')
	const [hasEfYaml, hasInitMarker] = await Promise.all([pathExists(efYamlPath), pathExists(initMarkerPath)])

	if (!hasEfYaml || hasInitMarker)
		return { kind: 'incomplete-initialization', root: candidateRoot }

	const worktreeResult = await deps.findWorktreeRoot(candidateRoot)
	if (worktreeResult.kind === 'git-unavailable')
		return worktreeResult
	if (worktreeResult.kind === 'not-a-worktree' || worktreeResult.root !== candidateRoot)
		return { kind: 'not-project-worktree-root', root: candidateRoot }

	let configText: string
	try {
		configText = decodeUtf8(await readFile(efYamlPath))
	}
	catch (error) {
		return { kind: 'read-error', root: candidateRoot, message: (error as Error).message }
	}

	const { config, diagnostics } = decodeConfig(configText, '.engineering/ef.yaml')

	if (!isExplicit) {
		const cwdWorktree = await deps.findWorktreeRoot(input.cwd)
		if (cwdWorktree.kind === 'git-unavailable')
			return cwdWorktree

		const withinOwnWorktree = cwdWorktree.kind === 'found' && cwdWorktree.root === candidateRoot
		const withinDeclaredLinkedRepo = cwdWorktree.kind === 'found' && config !== null
			&& config.linkedRepositories.some(descriptor => path.join(candidateRoot, descriptor.path) === cwdWorktree.root)

		if (!withinOwnWorktree && !withinDeclaredLinkedRepo)
			return { kind: 'unassociated', root: candidateRoot }
	}

	return { kind: 'resolved', root: candidateRoot, config, configDiagnostics: diagnostics }
}

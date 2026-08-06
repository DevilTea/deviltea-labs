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

import type { Diagnostic } from '../domain/diagnostics'
import type { WorktreeRootResult } from '../git/repository'
import type { ReadRegularFileNoFollowResult } from '../platform/fs-facts'
import type { Config } from './config'
import { lstat } from 'node:fs/promises'
import path from 'pathe'
import { isDirectory, readRegularFileNoFollow } from '../platform/fs-facts'
import { isSameLocation } from '../platform/path-identity'
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

function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: false })
		.decode(bytes)
}

/** Human-readable reason for every non-`ok` {@link ReadRegularFileNoFollowResult} kind, for a `read-error` message. */
function noFollowFailureReason(kind: Exclude<ReadRegularFileNoFollowResult['kind'], 'ok'>): string {
	switch (kind) {
		case 'not-found':
			return 'it could not be found when it was expected to exist'
		case 'not-a-regular-file':
			return 'it is not a regular file (it may be a symlink, directory, or other special entry); a managed configuration file must never be read through a symlink, even to a target inside the project'
		case 'identity-mismatch':
			return 'it changed between being observed and being opened'
	}
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
	// Both reads happen once, up front: `readRegularFileNoFollow` lstat's the
	// entry, then opens and `fstat`s it without following a symlink at the
	// final path component (Finding: `.engineering/ef.yaml` -> a symlink to a
	// file outside the project root must never be followed and used as
	// configuration, even transiently, before the later snapshot validator
	// can report `EF-FS-004`). `ef.yaml`'s bytes -- if it decoded as a genuine
	// regular file -- are captured now and reused below rather than reopened
	// by path a second time.
	const [efYamlRead, initMarkerRead] = await Promise.all([
		readRegularFileNoFollow(efYamlPath),
		readRegularFileNoFollow(initMarkerPath),
	])
	const hasEfYaml = efYamlRead.kind !== 'not-found'
	const hasInitMarker = initMarkerRead.kind !== 'not-found'

	if (!hasEfYaml || hasInitMarker)
		return { kind: 'incomplete-initialization', root: candidateRoot }

	const worktreeResult = await deps.findWorktreeRoot(candidateRoot)
	if (worktreeResult.kind === 'git-unavailable')
		return worktreeResult
	if (worktreeResult.kind === 'not-a-worktree' || !isSameLocation(worktreeResult.root, candidateRoot))
		return { kind: 'not-project-worktree-root', root: candidateRoot }

	if (efYamlRead.kind !== 'ok') {
		return {
			kind: 'read-error',
			root: candidateRoot,
			message: `'${efYamlPath}' exists but could not be read as configuration: ${noFollowFailureReason(efYamlRead.kind)}.`,
		}
	}
	const configText = decodeUtf8(efYamlRead.bytes)

	const { config, diagnostics } = decodeConfig(configText, '.engineering/ef.yaml')

	if (!isExplicit) {
		const cwdWorktree = await deps.findWorktreeRoot(input.cwd)
		if (cwdWorktree.kind === 'git-unavailable')
			return cwdWorktree

		const withinOwnWorktree = cwdWorktree.kind === 'found' && isSameLocation(cwdWorktree.root, candidateRoot)
		const withinDeclaredLinkedRepo = cwdWorktree.kind === 'found' && config !== null
			&& config.linkedRepositories.some(descriptor => isSameLocation(path.join(candidateRoot, descriptor.path), cwdWorktree.root))

		if (!withinOwnWorktree && !withinDeclaredLinkedRepo)
			return { kind: 'unassociated', root: candidateRoot }
	}

	return { kind: 'resolved', root: candidateRoot, config, configDiagnostics: diagnostics }
}

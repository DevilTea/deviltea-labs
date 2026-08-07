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
import type { FileIdentity, ReadRegularFileNoFollowResult } from '../platform/fs-facts'
import type { Config } from './config'
import { lstat } from 'node:fs/promises'
import path from 'pathe'
import { directoryIdentity, readRegularFileNoFollow } from '../platform/fs-facts'
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
	= | {
		kind: 'resolved'
		root: string
		config: Config | null
		configDiagnostics: Diagnostic[]
		/**
		 * `.engineering`'s `lstat`-derived identity, captured by THIS discovery
		 * (the `directoryIdentity` check just below, which already re-proves it
		 * is a real, non-symlink directory). Exposed (Finding 4, "single
		 * observation") so a caller that later performs its own, separate
		 * filesystem walk of `.engineering` -- `application/snapshot.ts`'s
		 * `loadSnapshotFromWorkingTree` -- can bind that walk to the EXACT
		 * directory this discovery approved, rather than trusting a bare path
		 * string that a race could have re-pointed at a different directory (one
		 * that, e.g., omits an Artifact file) between this observation and the
		 * later walk.
		 */
		engineeringIdentity: FileIdentity
	}
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

	// `directoryIdentity` returns an identity if and only if `engineeringPath`
	// is, right now, a real, non-symlink directory -- exactly the same
	// condition the previous plain `isDirectory` boolean check tested, but
	// this ALSO captures the `dev`/`ino` identity itself, threaded into
	// `DiscoverProjectResult`'s `engineeringIdentity` below (Finding 4).
	const engineeringIdentity = await directoryIdentity(engineeringPath)
	if (engineeringIdentity === undefined)
		return { kind: 'not-a-directory', path: engineeringPath }

	const efYamlPath = path.join(engineeringPath, 'ef.yaml')
	const tmpPath = path.join(engineeringPath, '.tmp')
	const initMarkerPath = path.join(tmpPath, 'init-state.json')

	// `containmentRoot: candidateRoot` on the `ef.yaml` read binds it to an
	// ancestor-verified `.engineering`: identity binding on the target file
	// alone cannot catch `.engineering` itself being moved out of the project
	// and symlinked back to that exact (relocated) directory (see
	// `platform/fs-facts.ts`'s `readRegularFileNoFollow` doc), which leaves the
	// file's own `dev`/`ino` unchanged even though it is now reached through a
	// forbidden ancestor symlink. This is safe here specifically because
	// `.engineering` was JUST proven to be a real, non-symlink directory by the
	// `directoryIdentity` check above.
	//
	// The init-marker read cannot unconditionally receive the same
	// `containmentRoot`, though: `.tmp` is only ever present during an actual
	// incomplete initialization, and `readRegularFileNoFollow`'s ancestor
	// verification treats a WHOLLY ABSENT ancestor identically to a forbidden
	// (non-directory) one -- applying it unconditionally would misreport
	// `identity-mismatch` (never `not-found`) for the overwhelmingly common
	// case of no `.tmp` at all, turning every ordinary, fully-initialized
	// project into a false `incomplete-initialization`. Gating on mere
	// existence first (`pathExists`, not `isDirectory`) still catches the
	// attack this protection exists for: a `.tmp` REPLACED BY a symlink is
	// itself "something existing" at that path, so `containmentRoot` is still
	// applied in exactly that case, and its ancestor verification then
	// correctly refuses the read as `identity-mismatch` for `.tmp` being a
	// symlink rather than a real directory -- rather than silently following
	// it through to whatever it now resolves to.
	const tmpAncestorExists = await pathExists(tmpPath)

	// Both reads happen once, up front: `readRegularFileNoFollow` lstat's the
	// entry, then opens and `fstat`s it without following a symlink at the
	// final path component (Finding: `.engineering/ef.yaml` -> a symlink to a
	// file outside the project root must never be followed and used as
	// configuration, even transiently, before the later snapshot validator
	// can report `EF-FS-004`). `ef.yaml`'s bytes -- if it decoded as a genuine
	// regular file -- are captured now and reused below rather than reopened
	// by path a second time.
	const [efYamlRead, initMarkerRead] = await Promise.all([
		readRegularFileNoFollow(efYamlPath, undefined, candidateRoot),
		readRegularFileNoFollow(initMarkerPath, undefined, tmpAncestorExists ? candidateRoot : undefined),
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
		const association = await checkWorkingDirectoryAssociation({ cwd: input.cwd, candidateRoot, config }, deps)
		if (association.kind === 'git-unavailable')
			return association
		if (association.kind === 'unassociated')
			return { kind: 'unassociated', root: candidateRoot }
	}

	return { kind: 'resolved', root: candidateRoot, config, configDiagnostics: diagnostics, engineeringIdentity }
}

// ---------------------------------------------------------------------------
// Working-directory association (extracted for reuse -- Finding 5)
// ---------------------------------------------------------------------------

export type WorkingDirectoryAssociationResult
	= | { kind: 'associated' }
		| { kind: 'unassociated' }
		| { kind: 'git-unavailable', message: string }

export interface CheckWorkingDirectoryAssociationInput {
	/** The working directory (absolute path) whose association is being decided. */
	cwd: string
	/** The discovered project root `cwd` is being checked against. */
	candidateRoot: string
	/** The configuration to check `cwd`'s association against. */
	config: Config | null
}

/**
 * Decide whether `cwd` is either inside the project's own Git worktree
 * (`candidateRoot` itself) or inside one of `config`'s declared linked
 * repositories (11-filesystem-and-config.md "Project Discovery": "validate
 * working-directory association with the project").
 *
 * Extracted out of `discoverProject`'s own inline logic (Finding 5, "single
 * observation") so a caller that later re-reads configuration from a
 * DIFFERENT, potentially fresher source than this module's own
 * `ef.yaml` read -- e.g. `application/snapshot.ts`'s
 * `loadSnapshotFromWorkingTree`, whose own separate read is the sole
 * authoritative config source for every command semantic downstream of it
 * (see `cli/project-context.ts`'s `ProjectContext.config` doc) -- can RE-RUN
 * this EXACT decision against that later, fresher `config`, rather than
 * relying on a decision `discoverProject` already made against its OWN,
 * potentially STALE observation of `ef.yaml`. Without re-running this check,
 * an in-place rewrite landing between `discoverProject`'s read and a later
 * snapshot load could let a command proceed from a nested worktree that was
 * only ever associated according to a configuration that no longer exists by
 * the time the rest of the command actually executes.
 *
 * `discoverProject` itself is one such caller (using its own, first-read
 * `config`); this function performs no filesystem access of its own beyond
 * `deps.findWorktreeRoot`.
 */
export async function checkWorkingDirectoryAssociation(input: CheckWorkingDirectoryAssociationInput, deps: DiscoverProjectDeps): Promise<WorkingDirectoryAssociationResult> {
	const cwdWorktree = await deps.findWorktreeRoot(input.cwd)
	if (cwdWorktree.kind === 'git-unavailable')
		return cwdWorktree

	const withinOwnWorktree = cwdWorktree.kind === 'found' && isSameLocation(cwdWorktree.root, input.candidateRoot)
	const withinDeclaredLinkedRepo = cwdWorktree.kind === 'found' && input.config !== null
		&& input.config.linkedRepositories.some(descriptor => isSameLocation(path.join(input.candidateRoot, descriptor.path), cwdWorktree.root))

	return (withinOwnWorktree || withinDeclaredLinkedRepo) ? { kind: 'associated' } : { kind: 'unassociated' }
}

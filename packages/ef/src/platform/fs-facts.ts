/**
 * lstat-based filesystem facts for validators (11-filesystem-and-config.md
 * symlink policy: "use `lstat` on every applicable existing component and
 * reject symlinks").
 *
 * Every function here inspects the path itself rather than a symlink's
 * resolved target, and treats a missing path as a normal (non-throwing)
 * fact rather than an error. Validators consume these as prepared facts; this
 * module performs no validation logic of its own.
 */

import type { Dirent, Stats } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readdir, readFile } from 'node:fs/promises'
import path from 'pathe'

async function tryLstat(target: string) {
	try {
		return await lstat(target)
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return undefined
		throw error
	}
}

/** `true` only for a regular file, per `lstat` (a symlink to a file is `false`: see module doc). */
export async function isRegularFile(target: string): Promise<boolean> {
	const stats = await tryLstat(target)
	return stats?.isFile() ?? false
}

/** `true` only for a real directory, per `lstat` (a symlink to a directory is `false`). */
export async function isDirectory(target: string): Promise<boolean> {
	const stats = await tryLstat(target)
	return stats?.isDirectory() ?? false
}

/** `true` for a symlink entry itself, regardless of what it resolves to or whether that target exists. */
export async function isSymlink(target: string): Promise<boolean> {
	const stats = await tryLstat(target)
	return stats?.isSymbolicLink() ?? false
}

/** `lstat`-derived identity of one filesystem entry, for binding a later read back to a specific prior observation (see {@link readRegularFileNoFollow}). */
export interface FileIdentity {
	dev: number
	ino: number
}

function identityOf(stats: Stats): FileIdentity {
	return { dev: stats.dev, ino: stats.ino }
}

/** `true` when two {@link FileIdentity} observations denote the identical filesystem entry (same device, same inode). */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

/**
 * `lstat`-derived identity of `target` if and only if it is, right now, a
 * real, non-symlink directory; `undefined` for anything else (missing, a
 * symlink -- even one that resolves to a directory --, a file, or any other
 * entry kind). The shared building block for every ancestor-identity
 * containment check in this module and its callers ({@link
 * readRegularFileNoFollow}'s `containmentRoot`; `application/init.ts`'s
 * claimed-`.engineering`-directory re-verification; `application/artifact-create.ts`'s
 * managed directory chain re-verification).
 */
export async function directoryIdentity(target: string): Promise<FileIdentity | undefined> {
	const stats = await tryLstat(target)
	if (stats === undefined || !stats.isDirectory())
		return undefined
	return identityOf(stats)
}

/**
 * Absolute paths of every directory strictly between `root` and `target`
 * (i.e. every path component of `target` relative to `root`, excluding
 * `target`'s own final component), nearest-`root` first. `undefined` when
 * `target` is not lexically contained beneath `root` at all -- a caller
 * error this function refuses to paper over by guessing.
 */
function ancestorDirectoriesBetween(root: string, target: string): string[] | undefined {
	const relative = path.relative(root, target)
	if (relative === '' || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative))
		return undefined

	const segments = relative.split('/')
		.filter(segment => segment.length > 0)
	segments.pop() // the final component (`target` itself) is not an ancestor

	const dirs: string[] = []
	let current = root
	for (const segment of segments) {
		current = path.join(current, segment)
		dirs.push(current)
	}
	return dirs
}

/** PRE-verification (see {@link readRegularFileNoFollow}): every ancestor between `root` and `target` must currently be a real, non-symlink directory; their identities are captured for the later POST-verification. `undefined` on any failure. */
async function captureAncestorIdentities(root: string, target: string): Promise<FileIdentity[] | undefined> {
	const dirs = ancestorDirectoriesBetween(root, target)
	if (dirs === undefined)
		return undefined

	const identities: FileIdentity[] = []
	for (const dir of dirs) {
		const identity = await directoryIdentity(dir)
		if (identity === undefined)
			return undefined
		identities.push(identity)
	}
	return identities
}

/** POST-verification (see {@link readRegularFileNoFollow}): every ancestor between `root` and `target` must still be a real, non-symlink directory with the identical identity `expected` captured earlier. */
async function ancestorIdentitiesStillMatch(root: string, target: string, expected: readonly FileIdentity[]): Promise<boolean> {
	const dirs = ancestorDirectoriesBetween(root, target)
	if (dirs === undefined || dirs.length !== expected.length)
		return false

	for (const [index, dir] of dirs.entries()) {
		const identity = await directoryIdentity(dir)
		if (identity === undefined || !sameFileIdentity(identity, expected[index]!))
			return false
	}
	return true
}

export interface WalkEntry {
	/** Path relative to `root`, using `/` separators. */
	relativePath: string
	isRegularFile: boolean
	isDirectory: boolean
	isSymlink: boolean
	/**
	 * `lstat` identity captured at walk time, for a caller that later reads
	 * this entry's bytes to bind that read to this exact observation via
	 * {@link readRegularFileNoFollow}'s `expectedIdentity`. Absent from a
	 * `WalkEntry` synthesized from a non-filesystem source (e.g. a Git tree
	 * listing), which has no `lstat` observation to carry.
	 */
	identity?: FileIdentity
}

async function walkInto(root: string, relativePrefix: string, out: WalkEntry[]): Promise<void> {
	const dirents: Dirent[] = await readdir(path.join(root, relativePrefix), { withFileTypes: true })

	for (const dirent of dirents) {
		const relativePath = relativePrefix ? path.join(relativePrefix, dirent.name) : dirent.name
		const absolutePath = path.join(root, relativePath)
		const stats = await lstat(absolutePath)
		const entry: WalkEntry = {
			relativePath,
			isRegularFile: stats.isFile(),
			isDirectory: stats.isDirectory(),
			isSymlink: stats.isSymbolicLink(),
			identity: identityOf(stats),
		}
		out.push(entry)

		if (entry.isDirectory)
			await walkInto(root, relativePath, out)
	}
}

/**
 * Recursively list every entry beneath `root` (not including `root` itself)
 * with its `lstat`-derived type flags. A symlinked directory is reported as
 * a symlink entry and is not descended into.
 */
export async function walkDirectory(root: string): Promise<WalkEntry[]> {
	const out: WalkEntry[] = []
	await walkInto(root, '', out)
	return out
}

/** Read the complete raw bytes of `path`, exactly as stored, for text/BOM/normalization inspection. */
export async function readFileBytes(target: string): Promise<Uint8Array> {
	return readFile(target)
}

export type ReadRegularFileNoFollowResult
	= | { kind: 'ok', bytes: Uint8Array }
		| { kind: 'not-found' }
		/** The entry exists but is not a regular file: a symlink, directory, FIFO, socket, device, or (for a Git-tree-derived caller) a gitlink. */
		| { kind: 'not-a-regular-file' }
		/**
		 * The entry changed between being observed (this function's own
		 * `lstat`, or the caller-supplied `expectedIdentity`) and being opened:
		 * it vanished and was replaced by a different regular file at the
		 * identical path, or its `fstat` identity otherwise no longer matches.
		 */
		| { kind: 'identity-mismatch' }

/**
 * `O_NOFOLLOW` rejects a symlink at the final path component outright,
 * refusing to open it even one step. Node exposes the constant on every
 * platform its `fs` module targets except Windows (where NTFS reparse
 * points/symlinks are not opened through the same POSIX open-flag surface);
 * on a runtime without it, plain read flags are used and the `lstat` kind
 * check plus the post-open `fstat` identity comparison below are the sole
 * (still sufficient) protection, since a symlink swapped in for the
 * original file resolves to a different `dev`/`ino` in every realistic case.
 */
const NO_FOLLOW_READ_FLAGS: number | string
	= typeof fsConstants.O_NOFOLLOW === 'number'
		? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
		: 'r'

/**
 * Read `target` as a regular file without ever following a symlink at its
 * final path component (11-filesystem-and-config.md symlink policy: "Validators
 * MUST reject a managed symlink even if its resolved target remains within
 * the project root").
 *
 * `lstat` classifies the entry itself first: anything other than a genuine
 * regular file (a symlink, directory, FIFO, socket, device, ...) is refused
 * as `not-a-regular-file` without ever attempting to open it -- this is what
 * stops a managed path such as `.engineering/ef.yaml` from being silently
 * read through a symlink to an external file. The file is then opened with
 * `O_NOFOLLOW` where available (refusing outright if the entry became a
 * symlink in the interim) and its `fstat` identity (`dev`+`ino`) is compared
 * against the initial `lstat` -- and, when supplied, `expectedIdentity`
 * (typically a prior observation such as `walkDirectory`'s recorded
 * `identity`) -- so that ANY replacement of the entry between observation and
 * open, not only a symlink swap, is refused as `identity-mismatch` rather
 * than silently returning a different file's bytes under the expected name.
 *
 * Binding to a caller-supplied `expectedIdentity` alone is NOT sufficient to
 * guard against an ancestor directory swapped for a symlink: moving the
 * directory that contains `target` out of the project and symlinking the
 * original path back to that exact (relocated) directory changes nothing
 * about `target`'s own `dev`/`ino` -- it is still, quite literally, the
 * identical inode -- so `expectedIdentity` alone still matches even though
 * the path used to reach it now runs through a forbidden ancestor symlink.
 * Node exposes no `openat`-style, file-descriptor-relative primitive to walk
 * a path while binding every component to an already-opened directory
 * handle, so this cannot be closed by a single race-free syscall sequence;
 * `containmentRoot`, when supplied, is the strongest available mitigation:
 * every path component between `containmentRoot` and `target` is treated as
 * an ancestor that must be, and remain, a real, non-symlink directory,
 * verified both before and after the read:
 *
 * 1. PRE-verification -- every ancestor from `containmentRoot` down to
 *    `target`'s parent is `lstat`'d; each must be a non-symlink directory,
 *    and its `dev`/`ino` is captured.
 * 2. `target` itself is opened `O_NOFOLLOW` and `fstat`'d exactly as
 *    described above.
 * 3. POST-verification -- every ancestor is re-`lstat`'d; each must still be
 *    a non-symlink directory with the SAME captured `dev`/`ino` as step 1.
 *
 * Any PRE- or POST-verification mismatch is refused as `identity-mismatch`,
 * even when step 2 already read the bytes successfully. This precisely
 * catches: symlinking an ancestor path back to the very directory that was
 * moved out of it (refused by PRE-verification: the ancestor is a symlink,
 * not a directory, at the moment of the call) and a swap that is restored to
 * a genuinely DIFFERENT directory before POST-verification runs (refused
 * because that different directory's `dev`/`ino` no longer matches step 1's
 * capture). The one race this cannot close is an attacker who swaps an
 * ancestor out and fully restores the SAME original directory to the SAME
 * path strictly between one of the checks above and the single operation it
 * guards -- in that narrow window every check still observes the genuine,
 * unchanged ancestor and target, so the bytes ultimately returned are still
 * the originally-observed inode's bytes; nothing else is ever exposed.
 *
 * `containmentRoot` is opt-in and fully backward compatible: omitting it
 * preserves the exact prior behavior (identity binding via `expectedIdentity`
 * alone, no ancestor verification), for a caller that has already verified
 * containment some other way or for which an ancestor swap is not part of
 * its threat model.
 */
export async function readRegularFileNoFollow(target: string, expectedIdentity?: FileIdentity, containmentRoot?: string): Promise<ReadRegularFileNoFollowResult> {
	let ancestorIdentities: FileIdentity[] | undefined
	if (containmentRoot !== undefined) {
		ancestorIdentities = await captureAncestorIdentities(containmentRoot, target)
		if (ancestorIdentities === undefined)
			return { kind: 'identity-mismatch' }
	}

	const observed = await tryLstat(target)
	if (observed === undefined)
		return { kind: 'not-found' }
	if (!observed.isFile())
		return { kind: 'not-a-regular-file' }
	const observedIdentity = identityOf(observed)
	if (expectedIdentity !== undefined && !sameFileIdentity(observedIdentity, expectedIdentity))
		return { kind: 'identity-mismatch' }

	let handle
	try {
		handle = await open(target, NO_FOLLOW_READ_FLAGS)
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT')
			return { kind: 'not-found' }
		// The entry passed the `lstat` check above as a regular file, but
		// `O_NOFOLLOW` refused it here: it became a symlink in between.
		if (code === 'ELOOP')
			return { kind: 'not-a-regular-file' }
		throw error
	}

	let result: ReadRegularFileNoFollowResult
	try {
		const opened = await handle.stat()
		if (!opened.isFile() || !sameFileIdentity(identityOf(opened), observedIdentity))
			result = { kind: 'identity-mismatch' }
		else
			result = { kind: 'ok', bytes: await handle.readFile() }
	}
	finally {
		await handle.close()
	}

	if (containmentRoot !== undefined && !(await ancestorIdentitiesStillMatch(containmentRoot, target, ancestorIdentities!)))
		return { kind: 'identity-mismatch' }

	return result
}

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

function identityMatches(a: FileIdentity, b: FileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino
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
 * Binding to a caller-supplied `expectedIdentity` is also what makes
 * re-verifying every ancestor directory component unnecessary for a caller
 * reading a file it walked earlier: an ancestor swapped for a symlink
 * between the walk and this read can only change what the final open
 * resolves to. If the opened file's identity still matches the one the
 * caller originally observed, it IS that exact file regardless of the path
 * taken to reach it; if it does not match (or the open fails outright), that
 * is exactly what the checks below catch.
 */
export async function readRegularFileNoFollow(target: string, expectedIdentity?: FileIdentity): Promise<ReadRegularFileNoFollowResult> {
	const observed = await tryLstat(target)
	if (observed === undefined)
		return { kind: 'not-found' }
	if (!observed.isFile())
		return { kind: 'not-a-regular-file' }
	const observedIdentity = identityOf(observed)
	if (expectedIdentity !== undefined && !identityMatches(observedIdentity, expectedIdentity))
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

	try {
		const opened = await handle.stat()
		if (!opened.isFile() || !identityMatches(identityOf(opened), observedIdentity))
			return { kind: 'identity-mismatch' }
		return { kind: 'ok', bytes: await handle.readFile() }
	}
	finally {
		await handle.close()
	}
}

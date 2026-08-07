/**
 * Draft Artifact hard-link publication primitives
 * (13-cli-contract.md "Draft Artifact hard-link publication").
 *
 * `writeTempFileComplete` performs step 3 (write, flush, close a complete
 * file at a temporary same-filesystem path). `publishViaHardLink` performs
 * step 5 (create the canonical target as a hard link to that complete
 * temporary file) and step 6 (treat target-exists as a race rejection
 * without replacement). Neither function falls back to rename, copy, or any
 * other visible-incremental-write protocol: an unsupported hard-link
 * capability is reported, never silently degraded.
 *
 * Finding (P0, fifteenth round): a prior implementation reported only
 * `{ outcome: 'written' }` on success -- no identity of the inode the
 * `open(path, 'wx+')` handle actually created. A caller that then needed an
 * ownership witness for that exact file had no choice but to re-derive one
 * from fresh PATHNAME observations made after the handle was already closed
 * (`readFile(path)`, then a fresh `lstat(path)`), and whatever real regular
 * file happened to occupy `path` by the time those ran got adopted as
 * "ours" -- including a foreign file a directory swap silently substituted
 * in at the exact same temporary basename in the interim.
 *
 * Finding (P0, sixteenth round): capturing `identity`/`bytes` from the
 * creating handle and then closing that handle before returning (as the
 * fifteenth-round fix did) is still not enough. Once the handle is closed,
 * the temporary file has only its pathname link; if another actor removes
 * that link, the underlying inode becomes free for the filesystem to recycle
 * -- and a byte-identical foreign replacement written at the exact same
 * basename can receive the exact same `(dev, ino)` the closed handle once
 * reported. `fileOwnershipProven`-style checks that compare a fresh pathname
 * `lstat` against that now-stale, no-longer-live identity are fooled: both
 * the identity comparison and a byte-content comparison agree, so a
 * chain-mismatch cleanup can unlink genuinely foreign state.
 *
 * `writeTempFileComplete` now keeps the creating handle OPEN and returns it
 * wrapped in an opaque {@link OwnedFileLease} rather than closing it before
 * returning. While a lease's handle stays open, POSIX guarantees the kernel
 * can never free that inode for reuse by an unrelated file -- so a fresh
 * `fstat` through the SAME retained handle (`OwnedFileLease.fstatLive`)
 * remains valid, current proof of exactly which file is being discussed for
 * as long as the lease is held, no matter what happens to the temporary
 * file's pathname link in the meantime. A caller compares a fresh pathname
 * observation against `fstatLive()`'s result -- never a statically captured
 * identity alone -- and calls `release()` only once no further destructive
 * ownership decision remains (publication and cleanup both resolved).
 */

import type { FileHandle } from 'node:fs/promises'
import type { FileIdentity } from './fs-facts'
import { Buffer } from 'node:buffer'
import { link, open } from 'node:fs/promises'

/**
 * The outcome of releasing an {@link OwnedFileLease}'s retained handle.
 * `release()` never throws (Finding P1, sixteenth round: a close rejection
 * must never override a caller's already-decided result by escaping as an
 * uncaught rejection) -- a close failure is reported as
 * `released-with-error` instead, so a caller can fold it into its own typed
 * result rather than letting it silently vanish or crash the invocation.
 */
export type LeaseReleaseResult
	= | { outcome: 'released' }
		| { outcome: 'released-with-error', error: NodeJS.ErrnoException }

/**
 * An opaque, still-open ownership witness for a file this invocation itself
 * created via `open(path, 'wx+')`. Returned by `writeTempFileComplete` (and,
 * identically, `platform/exclusive-file.ts`'s `createExclusive`) instead of
 * closing the creating handle before returning, so the underlying inode
 * stays pinned -- unrecyclable -- for as long as a destructive ownership
 * decision (publish-or-cleanup) might still need to be made against it.
 */
export interface OwnedFileLease {
	/** `fstat` identity captured immediately after this invocation's own creating handle wrote and verified this file, before it was ever closed. */
	readonly identity: FileIdentity
	/** The verification bytes read back through that same handle at creation time. */
	readonly bytes: Uint8Array
	/**
	 * A fresh `fstat` through the retained, still-open handle, taken RIGHT
	 * NOW. Returns `undefined` -- fail closed -- when: the lease has already
	 * been released (the handle is closed); the underlying entry no longer
	 * has ANY pathname referring to it (`nlink === 0`, e.g. this invocation's
	 * own creating link was removed and never replaced); or the `fstat` call
	 * itself fails for any other reason.
	 *
	 * A defined result is the strongest available proof that SOME pathname
	 * currently denotes this exact, still-live inode: while this handle stays
	 * open with at least one hard link, POSIX guarantees the kernel can never
	 * free this inode for reuse by an unrelated file, so no other real file
	 * could EVER report this identical `(dev, ino)` pair at the same moment --
	 * comparing this result against an independent, fresh pathname
	 * observation is therefore sound proof of "same file, right now," never a
	 * coincidence a filesystem's inode-recycling behavior could produce.
	 */
	fstatLive: () => Promise<FileIdentity | undefined>
	/**
	 * Close the retained handle. Never throws (see {@link LeaseReleaseResult}).
	 * Idempotent: calling this more than once simply reports the first call's
	 * outcome again, without attempting a second, invalid `close()`.
	 */
	release: () => Promise<LeaseReleaseResult>
}

function identityOf(stats: { dev: number, ino: number }): FileIdentity {
	return { dev: stats.dev, ino: stats.ino }
}

function createOwnedFileLease(handle: FileHandle, identity: FileIdentity, bytes: Uint8Array): OwnedFileLease {
	let released = false
	let releaseResult: LeaseReleaseResult | undefined

	return {
		identity,
		bytes,
		async fstatLive() {
			if (released)
				return undefined
			try {
				const stats = await handle.stat()
				if (stats.nlink === 0)
					return undefined
				return identityOf(stats)
			}
			catch {
				return undefined
			}
		},
		async release() {
			if (released)
				return releaseResult!
			released = true
			try {
				await handle.close()
				releaseResult = { outcome: 'released' }
			}
			catch (error) {
				releaseResult = { outcome: 'released-with-error', error: error as NodeJS.ErrnoException }
			}
			return releaseResult
		},
	}
}

export type WriteTempFileResult
	= | { outcome: 'written', lease: OwnedFileLease }
		| { outcome: 'already-exists' }
		| { outcome: 'failed', error: NodeJS.ErrnoException }

/**
 * Read exactly `size` bytes back through the already-open `handle`, at
 * explicit positions from the start of the file, rather than through
 * `handle.readFile()` -- which reads from the handle's CURRENT position
 * (already advanced past the just-written data by the preceding
 * `handle.writeFile()` call) rather than from the beginning. Explicit
 * positions also leave the handle's own file-position cursor untouched,
 * matching `handle.read()`'s documented behavior for a non-`null` `position`.
 */
async function readBackThroughHandle(handle: FileHandle, size: number): Promise<Uint8Array> {
	if (size === 0)
		return new Uint8Array(0)
	const buffer = Buffer.alloc(size)
	let offset = 0
	while (offset < size) {
		const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
		if (bytesRead === 0)
			break
		offset += bytesRead
	}
	return buffer.subarray(0, offset)
}

/**
 * Write and flush (`fsync`) a complete file at `path` with create-exclusive
 * (`wx+`) semantics, so a stale leftover temp name from a previous crashed
 * invocation is never silently overwritten.
 *
 * On success, the returned {@link OwnedFileLease}'s `identity` and `bytes`
 * are both captured from the exact `open(path, 'wx+')` handle this call
 * created -- `identity` via `handle.stat()`, `bytes` via a read back through
 * that same handle at explicit positions -- and the handle itself stays
 * OPEN, retained by the lease (Finding P0, sixteenth round): closing it here,
 * before ever returning, would let the underlying inode become recyclable
 * the moment any other actor removed the temporary file's one pathname link,
 * reopening exactly the ABA the fifteenth-round fix already closed for the
 * write itself. The caller MUST call `release()` once no further destructive
 * ownership decision against this file remains.
 */
export async function writeTempFileComplete(path: string, bytes: Uint8Array): Promise<WriteTempFileResult> {
	let handle
	try {
		// `wx+` (not plain `wx`): the create-exclusive semantics are identical,
		// but the handle also supports reading, so the verification read-back
		// below can go through this SAME handle rather than a second,
		// independent open of `path`.
		handle = await open(path, 'wx+')
	}
	catch (error) {
		const errno = error as NodeJS.ErrnoException
		if (errno.code === 'EEXIST')
			return { outcome: 'already-exists' }
		return { outcome: 'failed', error: errno }
	}

	try {
		await handle.writeFile(bytes)
		await handle.sync()
		const stats = await handle.stat()
		const identity = identityOf(stats)
		const readBack = await readBackThroughHandle(handle, stats.size)
		// The handle is deliberately NOT closed here: it is handed off, still
		// open, as the returned lease's ownership witness (see this function's
		// own doc and `OwnedFileLease`).
		return { outcome: 'written', lease: createOwnedFileLease(handle, identity, readBack) }
	}
	catch (error) {
		// Finding (P1, sixteenth round): a close failure here must never
		// override this branch's own `{ outcome: 'failed', error }` result --
		// there is no lease to report a close failure through on a failed
		// write, and the ORIGINAL write/read failure is what actually matters.
		// The close is still attempted so the fd is not leaked, but its own
		// outcome is discarded either way; letting it escape via `finally`
		// (the prior implementation's shape) would let a close rejection
		// silently replace this well-formed `failed` result with an uncaught
		// rejection instead.
		try {
			await handle.close()
		}
		catch {
			// Discarded -- see comment above.
		}
		return { outcome: 'failed', error: error as NodeJS.ErrnoException }
	}
}

/** Error codes that indicate the filesystem cannot provide same-filesystem hard-link semantics, rather than a genuine target-exists race. */
const UNSUPPORTED_CODES = new Set(['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'])

export type PublishViaHardLinkResult
	= | { outcome: 'published' }
		| { outcome: 'target-exists' }
		| { outcome: 'unsupported', error: NodeJS.ErrnoException }
		| { outcome: 'failed', error: NodeJS.ErrnoException }

/**
 * Publish `targetPath` as a hard link to the already-complete `tempPath`.
 * A pre-existing `targetPath` is a race rejection (`target-exists`), never
 * replaced. `EPERM`, `EXDEV`, and other capability-absence codes are reported
 * as `unsupported` so the caller can exit incomplete rather than falling back
 * to a non-conforming rename or copy publication.
 *
 * A hard link to a file with an open lease is unaffected by that lease: `link()`
 * operates purely on pathnames and inode reference counts, and Node opens
 * `tempPath`'s handle with Windows' `FILE_SHARE_DELETE` sharing flag by
 * default, so linking (or unlinking) the leased path succeeds on every
 * platform this package targets regardless of whether its lease is still
 * held.
 */
export async function publishViaHardLink(tempPath: string, targetPath: string): Promise<PublishViaHardLinkResult> {
	try {
		await link(tempPath, targetPath)
		return { outcome: 'published' }
	}
	catch (error) {
		const errno = error as NodeJS.ErrnoException
		if (errno.code === 'EEXIST')
			return { outcome: 'target-exists' }
		if (errno.code !== undefined && UNSUPPORTED_CODES.has(errno.code))
			return { outcome: 'unsupported', error: errno }
		return { outcome: 'failed', error: errno }
	}
}

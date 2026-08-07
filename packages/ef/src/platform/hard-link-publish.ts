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
 * in at the exact same temporary basename in the interim. `writeTempFileComplete`
 * now captures `identity` via `handle.stat()` (an `fstat` on the SAME open
 * handle `open(..., 'wx+')` returned, taken before the handle is ever closed)
 * and reads its verification `bytes` back through that SAME handle, at an
 * explicit position, rather than through any subsequent pathname operation.
 * Both are returned so a caller can construct its own ownership witness
 * EXCLUSIVELY from this handle-bound provenance, never from a later,
 * independent observation of `path`.
 */

import type { FileHandle } from 'node:fs/promises'
import type { FileIdentity } from './fs-facts'
import { Buffer } from 'node:buffer'
import { link, open } from 'node:fs/promises'

export type WriteTempFileResult
	= | { outcome: 'written', identity: FileIdentity, bytes: Uint8Array }
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
 * Write, flush (`fsync`), and close a complete file at `path` with
 * create-exclusive (`wx+`) semantics, so a stale leftover temp name from a
 * previous crashed invocation is never silently overwritten.
 *
 * On success, `identity` and `bytes` are both captured from the exact
 * `open(path, 'wx+')` handle this call created -- `identity` via
 * `handle.stat()`, `bytes` via a read back through that same handle at
 * explicit positions -- BEFORE the handle is closed. Neither is ever
 * re-derived from a pathname observation of `path` made afterward (see this
 * module's own doc, Finding P0, fifteenth round).
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
		const identity: FileIdentity = { dev: stats.dev, ino: stats.ino }
		const readBack = await readBackThroughHandle(handle, stats.size)
		return { outcome: 'written', identity, bytes: readBack }
	}
	catch (error) {
		return { outcome: 'failed', error: error as NodeJS.ErrnoException }
	}
	finally {
		await handle.close()
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

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
 */

import { link, open } from 'node:fs/promises'

export type WriteTempFileResult
	= | { outcome: 'written' }
		| { outcome: 'already-exists' }
		| { outcome: 'failed', error: NodeJS.ErrnoException }

/**
 * Write, flush (`fsync`), and close a complete file at `path` with
 * create-exclusive (`wx`) semantics, so a stale leftover temp name from a
 * previous crashed invocation is never silently overwritten.
 */
export async function writeTempFileComplete(path: string, bytes: Uint8Array): Promise<WriteTempFileResult> {
	let handle
	try {
		handle = await open(path, 'wx')
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
		return { outcome: 'written' }
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

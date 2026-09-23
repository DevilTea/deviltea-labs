import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { invalidRequest } from './errors'

/**
 * The optimistic revision check and the persistence write must be one
 * cross-process critical section. A process-local promise queue alone cannot
 * prevent two independent CLI processes from accepting the same revision.
 *
 * A crash may leave the lock in place. Fail closed rather than automatically
 * removing a potentially live lock; an operator can remove a confirmed stale
 * .spec-tool-v1.lock directory outside .spec/.
 */
const LOCK_TIMEOUT_MS = 30_000

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path)
		return true
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return false
		throw error
	}
}

async function waitForReaders(readerDirectory: string, deadline: number): Promise<void> {
	for (;;) {
		let readers: string[]
		try {
			readers = await readdir(readerDirectory)
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error
			readers = []
		}
		if (readers.length === 0)
			return
		if (Date.now() >= deadline) {
			throw invalidRequest([{
				path: '.spec-tool-v1.readers',
				reason: 'conflict',
				message: 'Workspace readers are still active, or a crashed reader left a stale token.',
			}])
		}
		await sleep(30)
	}
}

/** Safe against another reader creating a token while an empty directory is removed. */
async function releaseReader(readerDirectory: string, token: string, allowMissingToken = false): Promise<void> {
	try {
		await unlink(token)
	}
	catch (error) {
		if (!allowMissingToken || (error as NodeJS.ErrnoException).code !== 'ENOENT')
			throw error
	}
	try {
		await rmdir(readerDirectory)
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT')
			throw error
	}
}

/** Readers register before scanning .spec; the writer waits until they finish. */
export async function withWorkspaceReadLock<T>(root: string, action: () => Promise<T>): Promise<T> {
	const absolute = resolve(root)
	if (!await exists(absolute))
		return action()
	const writeLock = join(absolute, '.spec-tool-v1.lock')
	const readerDirectory = join(absolute, '.spec-tool-v1.readers')
	const deadline = Date.now() + LOCK_TIMEOUT_MS
	for (;;) {
		if (await exists(writeLock)) {
			if (Date.now() >= deadline) {
				throw invalidRequest([{
					path: '.spec-tool-v1.lock',
					reason: 'conflict',
					message: 'The workspace writer is still active, or the write lock is stale.',
				}])
			}
			await sleep(30)
			continue
		}
		await mkdir(readerDirectory, { recursive: true })
		const token = join(readerDirectory, randomUUID())
		try {
			await writeFile(token, '', { flag: 'wx' })
		}
		catch (error) {
			// Another reader can remove an empty directory after mkdir; retry
			// through the writer-lock check instead of assuming registration.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				continue
			// A token write may create a file before failing (EIO/ENOSPC).
			// Clean up our partial registration so writers cannot be blocked forever.
			await releaseReader(readerDirectory, token, true)
			throw error
		}
		if (await exists(writeLock)) {
			await releaseReader(readerDirectory, token)
			await sleep(30)
			continue
		}
		try {
			return await action()
		}
		finally {
			await releaseReader(readerDirectory, token)
		}
	}
}

export async function withWorkspaceWriteLock<T>(root: string, action: () => Promise<T>): Promise<T> {
	const lockPath = join(resolve(root), '.spec-tool-v1.lock')
	const deadline = Date.now() + LOCK_TIMEOUT_MS
	for (;;) {
		try {
			await mkdir(lockPath)
			break
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
				throw error
			if (Date.now() >= deadline) {
				throw invalidRequest([{
					path: '.spec-tool-v1.lock',
					reason: 'conflict',
					message: 'Another workspace mutation holds the write lock, or the lock is stale.',
				}])
			}
			await sleep(30)
		}
	}
	try {
		await waitForReaders(join(resolve(root), '.spec-tool-v1.readers'), deadline)
		return await action()
	}
	finally {
		await rmdir(lockPath)
	}
}

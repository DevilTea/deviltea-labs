import { mkdir, rmdir } from 'node:fs/promises'
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
export async function withWorkspaceWriteLock<T>(root: string, action: () => Promise<T>): Promise<T> {
	const lockPath = join(resolve(root), '.spec-tool-v1.lock')
	const deadline = Date.now() + 30_000
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
		return await action()
	}
	finally {
		await rmdir(lockPath)
	}
}

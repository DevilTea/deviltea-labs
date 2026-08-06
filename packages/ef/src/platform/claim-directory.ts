/**
 * Atomic `.engineering` claim (13-cli-contract.md "Initialization
 * claim-and-complete protocol" step 2; 11-filesystem-and-config.md "Runtime
 * and Derived State").
 *
 * A conforming `ef init` claims `.engineering` with exactly one non-recursive
 * directory creation. This module distinguishes the domain-relevant
 * already-exists outcome (a concurrent race or a pre-existing path that must
 * never be overwritten or merged with) from any other failure.
 */

import { mkdir } from 'node:fs/promises'

export type ClaimDirectoryResult
	= | { outcome: 'claimed' }
		| { outcome: 'already-exists' }
		| { outcome: 'failed', error: NodeJS.ErrnoException }

/**
 * Atomically claim `path` with one non-recursive directory creation.
 *
 * `already-exists` covers both a losing side of a concurrent claim race and a
 * pre-existing path (directory or otherwise) that must never be overwritten
 * or merged with. Every other failure, such as a missing parent directory or
 * a permission failure, is reported as `failed` with the raw error.
 */
export async function claimDirectory(path: string): Promise<ClaimDirectoryResult> {
	try {
		await mkdir(path, { recursive: false })
		return { outcome: 'claimed' }
	}
	catch (error) {
		const errno = error as NodeJS.ErrnoException
		if (errno.code === 'EEXIST')
			return { outcome: 'already-exists' }
		return { outcome: 'failed', error: errno }
	}
}

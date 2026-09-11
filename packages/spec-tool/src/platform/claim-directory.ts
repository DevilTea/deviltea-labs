/**
 * Atomic `.engineering` claim (13-cli-contract.md "Initialization
 * claim-and-complete protocol" step 2; 11-filesystem-and-config.md "Runtime
 * and Derived State").
 *
 * A conforming `ef init` claims `.engineering` with exactly one non-recursive
 * directory creation. This module distinguishes the domain-relevant
 * already-exists outcome (a concurrent race or a pre-existing path that must
 * never be overwritten or merged with) from any other failure, and -- because
 * a successful `mkdir` alone is not proof of ownership of anything a later
 * step reads back -- establishes and returns the claimed directory's identity
 * itself rather than leaving that to a separate, later, independently
 * racable observation by the caller.
 */

import type { FileIdentity } from './fs-facts'
import { lstat, mkdir, readdir } from 'node:fs/promises'

export type ClaimDirectoryResult
	= | { outcome: 'claimed', identity: FileIdentity }
		| { outcome: 'already-exists' }
		| { outcome: 'failed', error: NodeJS.ErrnoException }
		/**
		 * `mkdir` itself reported success, but the immediate post-creation
		 * observation below could not prove that `path` still denotes the exact,
		 * empty, non-symlink directory this invocation just created. Ownership
		 * cannot be established: the caller MUST treat this exactly like any
		 * other claim failure -- write nothing further, and, critically, delete
		 * NOTHING at `path`, since it may now be a real, pre-existing victim this
		 * invocation must never touch. See `claimDirectory`'s own documentation
		 * for the precise (harmless) residual race this cannot close.
		 */
		| { outcome: 'claim-unprovable', message: string }

/**
 * Atomically claim `path` with one non-recursive directory creation, then
 * establish ownership of the exact directory instance created by observing,
 * immediately afterward, that it is a real, non-symlink, EMPTY directory --
 * emptiness is a necessary property of an object this invocation alone just
 * created, since nothing else has had time to legitimately write into it.
 *
 * `already-exists` covers both a losing side of a concurrent claim race and a
 * pre-existing path (directory or otherwise) that must never be overwritten
 * or merged with. Every other `mkdir` failure, such as a missing parent
 * directory or a permission failure, is reported as `failed` with the raw
 * error.
 *
 * Node exposes no `openat`-style, file-descriptor-relative primitive that
 * could bind `mkdir` and this immediate observation into one atomic step
 * (00's "path handling is not a filesystem-security boundary"), so a
 * pathname-based race can still land strictly inside the narrow window
 * between them: only a genuinely EMPTY, non-symlink directory substituted
 * there is indistinguishable from the one this invocation created and is
 * accepted as `claimed`. That residual case can never destroy or disclose
 * pre-existing data -- an empty directory carries none -- so its only
 * possible consequence is that later steps operate on the wrong, but still
 * harmless, empty directory instance. Anything else observed in that window
 * (a symlink, a non-directory, or a NON-EMPTY directory -- which could only
 * be genuine pre-existing data this invocation must never destroy) fails
 * closed as `claim-unprovable` without deleting anything.
 */
export async function claimDirectory(path: string): Promise<ClaimDirectoryResult> {
	try {
		await mkdir(path, { recursive: false })
	}
	catch (error) {
		const errno = error as NodeJS.ErrnoException
		if (errno.code === 'EEXIST')
			return { outcome: 'already-exists' }
		return { outcome: 'failed', error: errno }
	}

	let stats
	try {
		stats = await lstat(path)
	}
	catch {
		return { outcome: 'claim-unprovable', message: `'${path}' could not be verified as a directory immediately after being claimed.` }
	}
	// `lstat` never follows a symlink, so a symlink swapped in for the entry
	// `mkdir` just believes it created is already excluded by this one check
	// (it reports `isDirectory() === false`, never `true`, for a symlink to a
	// directory).
	if (!stats.isDirectory())
		return { outcome: 'claim-unprovable', message: `'${path}' no longer denoted a non-symlink directory immediately after being claimed.` }

	let entries: string[]
	try {
		entries = await readdir(path)
	}
	catch {
		return { outcome: 'claim-unprovable', message: `'${path}' could not be listed immediately after being claimed.` }
	}
	if (entries.length > 0)
		return { outcome: 'claim-unprovable', message: `'${path}' was not empty immediately after being claimed.` }

	return { outcome: 'claimed', identity: { dev: stats.dev, ino: stats.ino } }
}

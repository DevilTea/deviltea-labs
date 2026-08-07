/**
 * Create-exclusive file writes and the `ef/init-state@1` marker
 * (13-cli-contract.md "Initialization claim-and-complete protocol").
 *
 * `createExclusive` is the general create-exclusive (`wx`) primitive used for
 * every planned `ef init` file and for `.engineering/.tmp/init-state.json`.
 * `writeInitMarker` / `readInitMarker` layer the exact marker shape and its
 * ownership-proving `nonce` on top of it.
 *
 * Finding (P0, matching `platform/hard-link-publish.ts`'s own
 * `writeTempFileComplete` finding, fifteenth round): a prior implementation
 * reported only `{ outcome: 'created' }` on success -- no identity of the
 * inode the `open(path, 'wx')` handle actually created. A caller that then
 * needed an ownership witness for that exact file had no choice but to
 * re-derive one from a fresh PATHNAME observation made after the handle was
 * already closed (`application/init.ts`'s own `regularFileIdentity(filePath)`
 * call immediately after `createExclusive` returned), and whatever real
 * regular file happened to occupy `path` by the time that ran got adopted as
 * "ours" -- including a foreign file a race silently substituted in at the
 * exact same path in the interim.
 *
 * Finding (P0, sixteenth round, matching `platform/hard-link-publish.ts`'s
 * own `writeTempFileComplete` finding): capturing `identity`/`bytes` from the
 * creating handle and then closing that handle before returning (as the
 * fifteenth-round fix did) is still not enough -- once closed, the created
 * file has only its pathname link, and a filesystem that recycles a
 * just-freed inode for a byte-identical foreign replacement at the same path
 * can report the exact same `(dev, ino)` the closed handle once did.
 * `createExclusive` now keeps the creating handle OPEN and returns it
 * wrapped in an opaque `OwnedFileLease` (re-exported from
 * `platform/hard-link-publish.ts`, whose own doc explains the mechanism in
 * full) rather than closing it before returning: while a lease's handle
 * stays open, POSIX guarantees the kernel can never free that inode for
 * reuse by an unrelated file, so a fresh `fstat` through that SAME retained
 * handle (`OwnedFileLease.fstatLive`) remains valid, current proof of exactly
 * which file is being discussed for as long as the lease is held. A caller
 * calls `release()` only once no further destructive ownership decision
 * against this file remains.
 */

import type { FileHandle } from 'node:fs/promises'
import type { FileIdentity } from './fs-facts'
import type { LeaseReleaseResult, OwnedFileLease } from './hard-link-publish'
import { Buffer } from 'node:buffer'
import { open, readFile } from 'node:fs/promises'

export type { LeaseReleaseResult, OwnedFileLease } from './hard-link-publish'

export type CreateExclusiveResult
	= | { outcome: 'created', lease: OwnedFileLease }
		| { outcome: 'already-exists' }
		| { outcome: 'failed', error: NodeJS.ErrnoException }

function identityOf(stats: { dev: number, ino: number }): FileIdentity {
	return { dev: stats.dev, ino: stats.ino }
}

/**
 * Deliberately duplicated from `platform/hard-link-publish.ts`'s identical
 * lease constructor rather than imported, so each create-exclusive primitive
 * family stays self-contained (matching this module's existing
 * `readBackThroughHandle` duplication, below). See
 * `platform/hard-link-publish.ts`'s `OwnedFileLease` doc for the full
 * inode-liveness rationale.
 */
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

/**
 * Read exactly `size` bytes back through the already-open `handle`, at
 * explicit positions from the start of the file, rather than through
 * `handle.readFile()` -- which reads from the handle's CURRENT position
 * (already advanced past the just-written data by the preceding
 * `handle.writeFile()` call) rather than from the beginning. Explicit
 * positions also leave the handle's own file-position cursor untouched,
 * matching `handle.read()`'s documented behavior for a non-`null` `position`.
 * Deliberately duplicated from `platform/hard-link-publish.ts`'s identical
 * helper rather than imported, so each create-exclusive primitive family
 * stays self-contained.
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
 * Create `path` with create-exclusive semantics and write exactly `bytes`. A
 * pre-existing path, whether from a genuine race or a stale leftover, is
 * reported as `already-exists` and is never truncated or overwritten.
 *
 * On success, the returned `OwnedFileLease`'s `identity` and `bytes` are both
 * captured from the exact `open(path, 'wx+')` handle this call created --
 * `identity` via `handle.stat()`, `bytes` via a read back through that same
 * handle at explicit positions -- and the handle itself stays OPEN, retained
 * by the lease (Finding P0, sixteenth round; see this module's own doc and
 * `platform/hard-link-publish.ts`'s `OwnedFileLease`). The caller MUST call
 * `release()` once no further destructive ownership decision against this
 * file remains.
 */
export async function createExclusive(path: string, bytes: Uint8Array): Promise<CreateExclusiveResult> {
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
		const stats = await handle.stat()
		const identity = identityOf(stats)
		const readBack = await readBackThroughHandle(handle, stats.size)
		// The handle is deliberately NOT closed here: it is handed off, still
		// open, as the returned lease's ownership witness (see this function's
		// own doc).
		return { outcome: 'created', lease: createOwnedFileLease(handle, identity, readBack) }
	}
	catch (error) {
		// Finding (P1, sixteenth round, matching `platform/hard-link-publish.ts`):
		// a close failure here must never override this branch's own
		// `{ outcome: 'failed', error }` result. The close is still attempted
		// so the fd is not leaked, but its own outcome is discarded either way.
		try {
			await handle.close()
		}
		catch {
			// Discarded -- see comment above.
		}
		return { outcome: 'failed', error: error as NodeJS.ErrnoException }
	}
}

// ---------------------------------------------------------------------------
// ef/init-state@1 marker (13-cli-contract.md)
// ---------------------------------------------------------------------------

const INIT_MARKER_SCHEMA = 'ef/init-state@1'

/** A freshly generated nonce is 128-bit lowercase hexadecimal (32 characters). */
const NONCE_PATTERN = /^[0-9a-f]{32}$/

export interface InitMarker {
	schema: typeof INIT_MARKER_SCHEMA
	nonce: string
}

/**
 * Create `.engineering/.tmp/init-state.json` at `path` with create-exclusive
 * semantics and exactly the marker shape `{"schema":"ef/init-state@1","nonce":"..."}`.
 */
export function writeInitMarker(path: string, nonce: string): Promise<CreateExclusiveResult> {
	const marker: InitMarker = { schema: INIT_MARKER_SCHEMA, nonce }
	const bytes = new TextEncoder()
		.encode(JSON.stringify(marker))
	return createExclusive(path, bytes)
}

export type ReadInitMarkerResult
	= | { outcome: 'found', marker: InitMarker }
		| { outcome: 'missing' }
		| { outcome: 'invalid' }
		| { outcome: 'failed', error: NodeJS.ErrnoException }

function isInitMarker(value: unknown): value is InitMarker {
	if (typeof value !== 'object' || value === null)
		return false
	const record = value as Record<string, unknown>
	return record.schema === INIT_MARKER_SCHEMA
		&& typeof record.nonce === 'string'
		&& NONCE_PATTERN.test(record.nonce)
}

/**
 * Read and decode the `ef/init-state@1` marker at `path`. `missing` and
 * `invalid` are distinguished so a caller can tell an absent claim apart from
 * a claim that exists but does not carry a trustworthy nonce.
 */
export async function readInitMarker(path: string): Promise<ReadInitMarkerResult> {
	let raw: Buffer
	try {
		raw = await readFile(path)
	}
	catch (error) {
		const errno = error as NodeJS.ErrnoException
		if (errno.code === 'ENOENT')
			return { outcome: 'missing' }
		return { outcome: 'failed', error: errno }
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw.toString('utf8'))
	}
	catch {
		return { outcome: 'invalid' }
	}

	if (!isInitMarker(parsed))
		return { outcome: 'invalid' }

	return { outcome: 'found', marker: parsed }
}

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
 * `writeTempFileComplete` finding): a prior implementation reported only
 * `{ outcome: 'created' }` on success -- no identity of the inode the
 * `open(path, 'wx')` handle actually created. A caller that then needed an
 * ownership witness for that exact file had no choice but to re-derive one
 * from a fresh PATHNAME observation made after the handle was already closed
 * (`application/init.ts`'s own `regularFileIdentity(filePath)` call
 * immediately after `createExclusive` returned), and whatever real regular
 * file happened to occupy `path` by the time that ran got adopted as "ours"
 * -- including a foreign file a race silently substituted in at the exact
 * same path in the interim. `createExclusive` now captures `identity` via
 * `handle.stat()` (an `fstat` on the SAME open handle `open(..., 'wx+')`
 * returned, taken before the handle is ever closed) and reads its
 * verification `bytes` back through that SAME handle, at an explicit
 * position, rather than through any subsequent pathname operation. Both are
 * returned so a caller can construct its own ownership witness EXCLUSIVELY
 * from this handle-bound provenance, never from a later, independent
 * observation of `path`.
 */

import type { FileHandle } from 'node:fs/promises'
import type { FileIdentity } from './fs-facts'
import { Buffer } from 'node:buffer'
import { open, readFile } from 'node:fs/promises'

export type CreateExclusiveResult
	= | { outcome: 'created', identity: FileIdentity, bytes: Uint8Array }
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
 * On success, `identity` and `bytes` are both captured from the exact
 * `open(path, 'wx+')` handle this call created -- `identity` via
 * `handle.stat()`, `bytes` via a read back through that same handle at
 * explicit positions -- BEFORE the handle is closed. Neither is ever
 * re-derived from a pathname observation of `path` made afterward (see this
 * module's own doc, Finding P0).
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
		const identity: FileIdentity = { dev: stats.dev, ino: stats.ino }
		const readBack = await readBackThroughHandle(handle, stats.size)
		return { outcome: 'created', identity, bytes: readBack }
	}
	catch (error) {
		return { outcome: 'failed', error: error as NodeJS.ErrnoException }
	}
	finally {
		await handle.close()
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

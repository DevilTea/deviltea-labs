/**
 * Create-exclusive file writes and the `ef/init-state@1` marker
 * (13-cli-contract.md "Initialization claim-and-complete protocol").
 *
 * `createExclusive` is the general create-exclusive (`wx`) primitive used for
 * `.engineering/.tmp/init-state.json`. `writeInitMarker` / `readInitMarker`
 * layer the exact marker shape and its ownership-proving `nonce` on top of it.
 */

import type { Buffer } from 'node:buffer'
import { open, readFile } from 'node:fs/promises'

export type CreateExclusiveResult
	= | { outcome: 'created' }
		| { outcome: 'already-exists' }
		| { outcome: 'failed', error: NodeJS.ErrnoException }

/**
 * Create `path` with create-exclusive (`wx`) semantics and write exactly
 * `bytes`. A pre-existing path, whether from a genuine race or a stale
 * leftover, is reported as `already-exists` and is never truncated or
 * overwritten.
 */
export async function createExclusive(path: string, bytes: Uint8Array): Promise<CreateExclusiveResult> {
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
		return { outcome: 'created' }
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

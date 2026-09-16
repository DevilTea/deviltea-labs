import type { Diagnostic } from './diagnostics'
import { randomBytes } from 'node:crypto'
import { diagnostic } from './diagnostics'

/** Canonical UUID text with version 7 and the RFC variant bits. */
export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuidV7(value: unknown): value is string {
	return typeof value === 'string' && UUID_V7_PATTERN.test(value)
}

export function validateUuidV7(value: unknown, path?: string, field = 'id'): Diagnostic[] {
	return isUuidV7(value)
		? []
		: [diagnostic('SPEC-IDENTITY-INVALID', `Artifact identity must be a UUIDv7; received ${JSON.stringify(value)}.`, { path, field })]
}

function toUuidText(bytes: Uint8Array): string {
	const hex = [...bytes].map(byte => byte.toString(16)
		.padStart(2, '0'))
		.join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Generate an opaque, collision-resistant UUIDv7 for a new Artifact. */
export function generateUuidV7(now = Date.now()): string {
	const bytes = randomBytes(16)
	let timestamp = Number.isFinite(now) ? Math.trunc(now) : Date.now()
	if (timestamp < 0)
		timestamp = 0
	if (timestamp > 0xFFFFFFFFFFFF)
		timestamp = 0xFFFFFFFFFFFF
	for (let index = 5; index >= 0; index--) {
		bytes[index] = timestamp % 256
		timestamp = Math.floor(timestamp / 256)
	}
	bytes[6] = (bytes[6]! & 0x0F) | 0x70
	bytes[8] = (bytes[8]! & 0x3F) | 0x80
	return toUuidText(bytes)
}

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidV7(value: unknown): value is string {
	return typeof value === 'string' && UUID_V7_PATTERN.test(value)
}

export function newUuidV7(now = Date.now()): string {
	const bytes = randomBytes(16)
	let timestamp = Math.max(0, Math.min(0xFFFFFFFFFFFF, Math.trunc(now)))
	for (let index = 5; index >= 0; index--) {
		bytes[index] = timestamp & 0xFF
		timestamp = Math.floor(timestamp / 256)
	}
	bytes[6] = (bytes[6]! & 0x0F) | 0x70
	bytes[8] = (bytes[8]! & 0x3F) | 0x80
	const hex = Buffer.from(bytes)
		.toString('hex')
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join('-')
}

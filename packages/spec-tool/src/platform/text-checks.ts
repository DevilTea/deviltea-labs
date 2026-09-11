/**
 * Byte-level text checks for authoritative text files (11-filesystem-and-config.md
 * "Text and Path Normalization": UTF-8, LF line endings, no BOM, one final
 * newline) and the implementation-decisions requirement to preserve original
 * bytes long enough to diagnose BOM, invalid UTF-8, CRLF, and missing final
 * newline.
 *
 * These functions are pure byte inspection: they return raw findings with
 * byte offset and one-based line position. Emitting the `EF-FS-005`
 * diagnostic itself, including its message text, is the repository layer's
 * responsibility.
 */

/** A byte position: a 0-based byte offset and its one-based line number. */
export interface BytePosition {
	offset: number
	line: number
}

const LF = 0x0A
const CR = 0x0D

/** One-based line number of `offset`, counting every LF byte strictly before it. */
function lineAt(bytes: Uint8Array, offset: number): number {
	let line = 1
	for (let i = 0; i < offset; i++) {
		if (bytes[i] === LF)
			line++
	}
	return line
}

const BOM = [0xEF, 0xBB, 0xBF]

/** Detect a leading UTF-8 byte-order mark, forbidden by the Core text-normalization rules. */
export function detectBom(bytes: Uint8Array): BytePosition | undefined {
	if (bytes.length >= BOM.length && BOM.every((byte, index) => bytes[index] === byte))
		return { offset: 0, line: 1 }
	return undefined
}

/** Detect every CRLF line terminator; the offset is the position of the CR byte. A bare CR without a following LF is not reported here. */
export function detectCrlf(bytes: Uint8Array): BytePosition[] {
	const findings: BytePosition[] = []
	let line = 1
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]
		if (byte === CR && bytes[i + 1] === LF)
			findings.push({ offset: i, line })
		if (byte === LF)
			line++
	}
	return findings
}

/**
 * Detect a missing single final newline. An empty file has no final newline
 * at all and is reported at offset 0. A non-empty file whose last byte is not
 * LF is reported at the end-of-file offset.
 */
export function detectMissingFinalNewline(bytes: Uint8Array): BytePosition | undefined {
	if (bytes.length === 0)
		return { offset: 0, line: 1 }
	if (bytes[bytes.length - 1] !== LF)
		return { offset: bytes.length, line: lineAt(bytes, bytes.length) }
	return undefined
}

/**
 * Detect the first byte position at which `bytes` violates well-formed UTF-8:
 * an invalid leading byte, a missing or malformed continuation byte, a
 * truncated sequence at end of file, an overlong encoding, an out-of-range
 * code point, or an encoded UTF-16 surrogate half. Returns `undefined` when
 * every byte forms well-formed UTF-8.
 */
export function detectInvalidUtf8(bytes: Uint8Array): BytePosition | undefined {
	let i = 0
	while (i < bytes.length) {
		const lead = bytes[i]!

		if (lead <= 0x7F) {
			i++
			continue
		}

		let length: number
		let min: number
		if ((lead & 0xE0) === 0xC0) {
			length = 2
			min = 0x80
		}
		else if ((lead & 0xF0) === 0xE0) {
			length = 3
			min = 0x800
		}
		else if ((lead & 0xF8) === 0xF0) {
			length = 4
			min = 0x10000
		}
		else {
			return { offset: i, line: lineAt(bytes, i) }
		}

		if (i + length > bytes.length)
			return { offset: i, line: lineAt(bytes, i) }

		let codepoint = lead & (0xFF >> (length + 1))
		for (let k = 1; k < length; k++) {
			const continuation = bytes[i + k]!
			if ((continuation & 0xC0) !== 0x80)
				return { offset: i, line: lineAt(bytes, i) }
			codepoint = (codepoint << 6) | (continuation & 0x3F)
		}

		const isSurrogate = codepoint >= 0xD800 && codepoint <= 0xDFFF
		if (codepoint < min || codepoint > 0x10FFFF || isSurrogate)
			return { offset: i, line: lineAt(bytes, i) }

		i += length
	}
	return undefined
}

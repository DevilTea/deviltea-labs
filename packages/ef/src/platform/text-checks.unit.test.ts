import { describe, expect, it } from 'vitest'
import { detectBom, detectCrlf, detectInvalidUtf8, detectMissingFinalNewline } from './text-checks'

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values)
}

function utf8(text: string): Uint8Array {
	return new TextEncoder()
		.encode(text)
}

describe('detectBom', () => {
	it('detects a leading UTF-8 BOM at offset 0, line 1', () => {
		const content = bytes(0xEF, 0xBB, 0xBF, 0x61, 0x0A)
		expect(detectBom(content))
			.toEqual({ offset: 0, line: 1 })
	})

	it('returns undefined when there is no BOM', () => {
		expect(detectBom(utf8('schema: ef/config@1\n')))
			.toBeUndefined()
	})

	it('returns undefined for a file too short to contain a BOM', () => {
		expect(detectBom(bytes(0xEF, 0xBB)))
			.toBeUndefined()
	})

	it('does not treat a BOM-like sequence appearing after the start as a BOM', () => {
		const content = bytes(0x61, 0xEF, 0xBB, 0xBF)
		expect(detectBom(content))
			.toBeUndefined()
	})
})

describe('detectCrlf', () => {
	it('returns an empty array for LF-only content', () => {
		expect(detectCrlf(utf8('line one\nline two\n')))
			.toEqual([])
	})

	it('finds a single CRLF terminator with its byte offset and line number', () => {
		const content = utf8('line one\r\nline two\n')
		expect(detectCrlf(content))
			.toEqual([{ offset: 8, line: 1 }])
	})

	it('finds every CRLF terminator across multiple lines', () => {
		const content = utf8('a\r\nb\r\nc\n')
		expect(detectCrlf(content))
			.toEqual([
				{ offset: 1, line: 1 },
				{ offset: 4, line: 2 },
			])
	})

	it('does not report a bare CR without a following LF', () => {
		const content = bytes(0x61, 0x0D, 0x62, 0x0A)
		expect(detectCrlf(content))
			.toEqual([])
	})
})

describe('detectMissingFinalNewline', () => {
	it('returns undefined when the file ends with exactly one LF', () => {
		expect(detectMissingFinalNewline(utf8('schema: ef/config@1\n')))
			.toBeUndefined()
	})

	it('reports the end-of-file position when the last byte is not LF', () => {
		const content = utf8('schema: ef/config@1')
		expect(detectMissingFinalNewline(content))
			.toEqual({ offset: content.length, line: 1 })
	})

	it('computes the line number of a missing final newline on a multi-line file', () => {
		const content = utf8('one\ntwo\nthree')
		expect(detectMissingFinalNewline(content))
			.toEqual({ offset: content.length, line: 3 })
	})

	it('treats an empty file as missing its final newline', () => {
		expect(detectMissingFinalNewline(bytes()))
			.toEqual({ offset: 0, line: 1 })
	})

	it('does not flag a file ending with two newlines (blank final line, not missing)', () => {
		expect(detectMissingFinalNewline(utf8('one\n\n')))
			.toBeUndefined()
	})
})

describe('detectInvalidUtf8', () => {
	it('returns undefined for valid ASCII and multi-byte UTF-8', () => {
		expect(detectInvalidUtf8(utf8('plain ascii\n')))
			.toBeUndefined()
		// U+00E9 (é, 2-byte), U+4E2D (中, 3-byte), U+1F600 (😀, 4-byte).
		expect(detectInvalidUtf8(utf8('café 中 😀\n')))
			.toBeUndefined()
	})

	it('detects a lone continuation byte', () => {
		const content = bytes(0x61, 0x80, 0x62)
		expect(detectInvalidUtf8(content))
			.toEqual({ offset: 1, line: 1 })
	})

	it('detects a truncated multi-byte sequence at end of file', () => {
		const content = bytes(0x61, 0xE4, 0xB8)
		expect(detectInvalidUtf8(content))
			.toEqual({ offset: 1, line: 1 })
	})

	it('detects an overlong encoding', () => {
		// 0xC0 0x80 is an overlong two-byte encoding of NUL (must be one byte).
		const content = bytes(0x61, 0xC0, 0x80)
		expect(detectInvalidUtf8(content))
			.toEqual({ offset: 1, line: 1 })
	})

	it('detects an encoded UTF-16 surrogate half', () => {
		// 0xED 0xA0 0x80 encodes U+D800, a surrogate, forbidden in UTF-8.
		const content = bytes(0x61, 0xED, 0xA0, 0x80)
		expect(detectInvalidUtf8(content))
			.toEqual({ offset: 1, line: 1 })
	})

	it('reports the correct line number when the invalid byte follows earlier newlines', () => {
		const content = Uint8Array.from([...utf8('one\ntwo\n'), 0x80, 0x63])
		expect(detectInvalidUtf8(content))
			.toEqual({ offset: 8, line: 3 })
	})
})

import { Buffer } from 'node:buffer'
import process from 'node:process'
import * as clack from '@clack/prompts'
import { describe, expect, it, vi } from 'vitest'
import { createRealPrompts, withRedirectedStdout } from './prompts'

vi.mock('@clack/prompts', () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	note: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	isCancel: vi.fn(),
}))

/** Flush the microtask queue so the `void withRedirectedStdout(...)` fire-and-forget calls (intro/outro/note) settle. */
async function flushMicrotasks(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

describe('withRedirectedStdout', () => {
	it('forwards every process.stdout.write call to the sink instead of the real stream', async () => {
		const captured: string[] = []
		const originalWrite = process.stdout.write

		const result = await withRedirectedStdout(chunk => captured.push(chunk), async () => {
			process.stdout.write('hello ')
			process.stdout.write('world')
			return 42
		})

		expect(result)
			.toBe(42)
		expect(captured)
			.toEqual(['hello ', 'world'])
		expect(process.stdout.write)
			.toBe(originalWrite)
	})

	it('restores the original process.stdout.write even when the wrapped function throws', async () => {
		const originalWrite = process.stdout.write

		await expect(withRedirectedStdout(() => {}, async () => {
			throw new Error('boom')
		})).rejects.toThrow('boom')

		expect(process.stdout.write)
			.toBe(originalWrite)
	})

	it('never writes the redirected bytes to the real stdout stream', async () => {
		const originalWrite = process.stdout.write
		const realWrites: unknown[] = []
		process.stdout.write = ((chunk: unknown) => {
			realWrites.push(chunk)
			return true
		}) as typeof process.stdout.write

		try {
			await withRedirectedStdout(() => {}, async () => {
				// Nested call: the wrapped function's own `process.stdout.write` calls
				// must hit the sink, not the (temporarily real-looking) spy installed
				// just above, proving the redirect layers correctly.
				process.stdout.write('inner')
			})
		}
		finally {
			process.stdout.write = originalWrite
		}

		expect(realWrites)
			.toEqual([])
	})

	it('decodes non-string chunks (e.g. a Buffer) as utf8 before forwarding to the sink', async () => {
		const captured: string[] = []

		await withRedirectedStdout(chunk => captured.push(chunk), async () => {
			process.stdout.write(Buffer.from('binary chunk', 'utf8'))
		})

		expect(captured)
			.toEqual(['binary chunk'])
	})
})

describe('createRealPrompts', () => {
	it('constructs an object exposing the complete Prompts surface', () => {
		const prompts = createRealPrompts(() => {})
		expect(typeof prompts.intro)
			.toBe('function')
		expect(typeof prompts.outro)
			.toBe('function')
		expect(typeof prompts.note)
			.toBe('function')
		expect(typeof prompts.text)
			.toBe('function')
		expect(typeof prompts.confirm)
			.toBe('function')
		expect(typeof prompts.confirmMutation)
			.toBe('function')
	})

	it('intro() redirects any process.stdout.write performed by clack.intro to the sink', async () => {
		const originalWrite = process.stdout.write
		const sink = vi.fn()
		vi.mocked(clack.intro)
			.mockImplementation((title) => {
				process.stdout.write(`intro:${String(title)}`)
			})

		createRealPrompts(sink)
			.intro('Hello')
		await flushMicrotasks()

		expect(sink)
			.toHaveBeenCalledWith('intro:Hello')
		expect(process.stdout.write)
			.toBe(originalWrite)
	})

	it('outro() redirects any process.stdout.write performed by clack.outro to the sink', async () => {
		const sink = vi.fn()
		vi.mocked(clack.outro)
			.mockImplementation((message) => {
				process.stdout.write(`outro:${String(message)}`)
			})

		createRealPrompts(sink)
			.outro('Bye')
		await flushMicrotasks()

		expect(sink)
			.toHaveBeenCalledWith('outro:Bye')
	})

	it('note() forwards message and title to clack.note and redirects its output to the sink', async () => {
		const sink = vi.fn()
		vi.mocked(clack.note)
			.mockImplementation((message, title) => {
				process.stdout.write(`note:${String(title)}:${String(message)}`)
			})

		createRealPrompts(sink)
			.note('body text', 'Title')
		await flushMicrotasks()

		expect(clack.note)
			.toHaveBeenCalledWith('body text', 'Title')
		expect(sink)
			.toHaveBeenCalledWith('note:Title:body text')
	})

	it('text() returns the entered value when the prompt is not cancelled', async () => {
		vi.mocked(clack.text)
			.mockResolvedValue('Alice')
		vi.mocked(clack.isCancel)
			.mockReturnValue(false)

		const result = await createRealPrompts(() => {})
			.text({ message: 'Name?' })

		expect(result)
			.toBe('Alice')
		expect(clack.text)
			.toHaveBeenCalledWith(expect.objectContaining({ message: 'Name?' }))
	})

	it('text() returns undefined when the prompt is cancelled', async () => {
		const cancelToken = Symbol('cancel')
		vi.mocked(clack.text)
			.mockResolvedValue(cancelToken as unknown as string)
		vi.mocked(clack.isCancel)
			.mockReturnValue(true)

		const result = await createRealPrompts(() => {})
			.text({ message: 'Name?' })

		expect(result)
			.toBeUndefined()
	})

	it('confirm() returns the boolean answer when the prompt is not cancelled', async () => {
		vi.mocked(clack.confirm)
			.mockResolvedValue(true)
		vi.mocked(clack.isCancel)
			.mockReturnValue(false)

		const result = await createRealPrompts(() => {})
			.confirm({ message: 'Continue?' })

		expect(result)
			.toBe(true)
	})

	it('confirm() returns undefined when the prompt is cancelled', async () => {
		const cancelToken = Symbol('cancel')
		vi.mocked(clack.confirm)
			.mockResolvedValue(cancelToken as unknown as boolean)
		vi.mocked(clack.isCancel)
			.mockReturnValue(true)

		const result = await createRealPrompts(() => {})
			.confirm({ message: 'Continue?' })

		expect(result)
			.toBeUndefined()
	})

	it('confirmMutation() shows the plan via note() then returns the confirm answer directly', async () => {
		vi.mocked(clack.confirm)
			.mockResolvedValue(true)
		vi.mocked(clack.isCancel)
			.mockReturnValue(false)

		const result = await createRealPrompts(() => {})
			.confirmMutation({ title: 'Plan', lines: ['a', 'b'] })

		expect(clack.note)
			.toHaveBeenCalledWith('a\nb', 'Plan')
		expect(clack.confirm)
			.toHaveBeenCalledWith({ message: 'Apply this plan?', initialValue: false })
		expect(result)
			.toBe(true)
	})

	it('confirmMutation() returns false when the answer is an explicit decline', async () => {
		vi.mocked(clack.confirm)
			.mockResolvedValue(false)
		vi.mocked(clack.isCancel)
			.mockReturnValue(false)

		const result = await createRealPrompts(() => {})
			.confirmMutation({ title: 'Plan', lines: ['a'] })

		expect(result)
			.toBe(false)
	})

	it('confirmMutation() returns false when the prompt is cancelled', async () => {
		const cancelToken = Symbol('cancel')
		vi.mocked(clack.confirm)
			.mockResolvedValue(cancelToken as unknown as boolean)
		vi.mocked(clack.isCancel)
			.mockReturnValue(true)

		const result = await createRealPrompts(() => {})
			.confirmMutation({ title: 'Plan', lines: ['a'] })

		expect(result)
			.toBe(false)
	})
})

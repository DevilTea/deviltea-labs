/**
 * Interactive human-mode prompts (13-cli-contract.md "Human Output": "writes
 * prompts to stderr"; "Mutation Planning and Authorization": "the CLI
 * displays the plan and requests confirmation").
 *
 * `@clack/prompts` (00-implementation-decisions.md's mandated interactive
 * library) renders unconditionally to `process.stdout` and reads
 * unconditionally from `process.stdin`; its public API has no injectable
 * output stream (unlike the lower-level `@clack/core` primitives it wraps,
 * which are not a direct dependency of this package). Since the CLI contract
 * requires every prompt to land on stderr, `withRedirectedStdout` temporarily
 * replaces `process.stdout.write` for the duration of one prompt call,
 * forwarding every chunk to the CLI's own stderr sink instead, then restores
 * the original function -- `@clack/prompts` reads `process.stdout.write`
 * fresh on every call rather than caching a reference, so this redirection is
 * complete for the scope of the wrapped call. This is a deliberate,
 * documented resolution of that library/contract tension rather than an
 * unexamined workaround.
 *
 * The `Prompts` interface is the command layer's only dependency on any of
 * this: tests inject a scripted fake instead of driving real stdin/stdout.
 */

import { Buffer } from 'node:buffer'
import process from 'node:process'
import * as clack from '@clack/prompts'

export interface MutationPlanPreview {
	title: string
	lines: readonly string[]
}

export interface TextPromptOptions {
	message: string
	placeholder?: string
	initialValue?: string
	validate?: (value: string) => string | undefined
}

export interface ConfirmPromptOptions {
	message: string
	initialValue?: boolean
}

export interface Prompts {
	intro: (title: string) => void
	outro: (message: string) => void
	note: (message: string, title?: string) => void
	/** `undefined` means the prompt was cancelled (Ctrl-C). */
	text: (options: TextPromptOptions) => Promise<string | undefined>
	/** `undefined` means the prompt was cancelled (Ctrl-C). */
	confirm: (options: ConfirmPromptOptions) => Promise<boolean | undefined>
	/** Display the plan, then ask for confirmation. `false` covers both an explicit decline and cancellation. */
	confirmMutation: (preview: MutationPlanPreview) => Promise<boolean>
}

/** Temporarily redirect every `process.stdout.write` call during `fn` to `sink`, then restore the original. */
export async function withRedirectedStdout<T>(sink: (chunk: string) => void, fn: () => Promise<T>): Promise<T> {
	const original = process.stdout.write
	process.stdout.write = ((chunk: unknown) => {
		sink(typeof chunk === 'string'
			? chunk
			: Buffer.from(chunk as Uint8Array)
					.toString('utf8'))
		return true
	}) as typeof process.stdout.write
	try {
		return await fn()
	}
	finally {
		process.stdout.write = original
	}
}

/** Real `@clack/prompts`-backed implementation, rendering to `stderrWrite` instead of `process.stdout`. */
export function createRealPrompts(stderrWrite: (chunk: string) => void): Prompts {
	function redirected<T>(fn: () => Promise<T>): Promise<T> {
		return withRedirectedStdout(stderrWrite, fn)
	}

	return {
		intro: (title: string) => {
			void withRedirectedStdout(stderrWrite, async () => clack.intro(title))
		},
		outro: (message: string) => {
			void withRedirectedStdout(stderrWrite, async () => clack.outro(message))
		},
		note: (message: string, title?: string) => {
			void withRedirectedStdout(stderrWrite, async () => clack.note(message, title))
		},
		text: async (options: TextPromptOptions) => {
			const result = await redirected(() => clack.text({
				message: options.message,
				placeholder: options.placeholder,
				initialValue: options.initialValue,
				validate: options.validate,
			}))
			return clack.isCancel(result) ? undefined : result
		},
		confirm: async (options: ConfirmPromptOptions) => {
			const result = await redirected(() => clack.confirm({ message: options.message, initialValue: options.initialValue }))
			return clack.isCancel(result) ? undefined : result
		},
		confirmMutation: async (preview: MutationPlanPreview) => {
			await redirected(async () => {
				clack.note(preview.lines.join('\n'), preview.title)
			})
			const result = await redirected(() => clack.confirm({ message: 'Apply this plan?', initialValue: false }))
			if (clack.isCancel(result))
				return false
			return result
		},
	}
}

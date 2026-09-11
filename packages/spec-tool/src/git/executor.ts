/**
 * Git process executor (00-implementation-decisions.md, "Git Execution").
 *
 * The sole boundary that spawns the `git` executable. It never passes
 * user-controlled arbitrary Git options, always uses `shell: false` with an
 * explicit argument array, and constructs a sanitized child environment so
 * repository-selecting Git variables inherited from the parent process
 * (`GIT_DIR` and friends) cannot silently redirect a command to an
 * unintended repository. Repository-scoped commands are issued through an
 * explicit `-C <root>` rather than by relying on `process.cwd()`.
 *
 * This module owns cancellation, child cleanup, output limits, and
 * executable-unavailable errors. It does not interpret Git's exit status:
 * a non-zero `exitCode` is ordinary result data for the caller to interpret,
 * not a thrown error. Only conditions that prevent obtaining that result at
 * all (the executable is missing, output exceeded the configured limit, or
 * the caller aborted) are reported as a typed `GitExecFailure`.
 */

import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'

/** Repository-selecting Git environment variables the executor always strips. */
const STRIPPED_ENV_KEYS: ReadonlySet<string> = new Set([
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_COMMON_DIR',
	'GIT_INDEX_FILE',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_NAMESPACE',
])

/** Dynamic `GIT_CONFIG_*` override keys the executor always strips. */
const DYNAMIC_CONFIG_KEY_PATTERN = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/

/** Fixed values the executor forces regardless of the parent environment. */
const FIXED_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: '0',
	GIT_NO_REPLACE_OBJECTS: '1',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_PAGER: 'cat',
	PAGER: 'cat',
	LC_ALL: 'C',
}

/**
 * Build a sanitized child environment from `base`: strip repository-selecting
 * and dynamic Git config-override variables, then force the fixed
 * diagnostic/behavior variables. Exported as a pure function so the policy is
 * independently testable without spawning a process.
 */
export function sanitizeGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined)
			continue
		if (STRIPPED_ENV_KEYS.has(key))
			continue
		if (DYNAMIC_CONFIG_KEY_PATTERN.test(key))
			continue
		result[key] = value
	}
	Object.assign(result, FIXED_ENV)
	return result
}

export interface GitExecResult {
	stdout: Buffer
	stderr: Buffer
	exitCode: number | null
	signal: NodeJS.Signals | null
}

export type GitExecFailure
	= | { kind: 'unavailable', message: string }
		| { kind: 'output-limit-exceeded', stream: 'stdout' | 'stderr', limitBytes: number }
		| { kind: 'aborted' }

export type GitExecOutcome
	= | { ok: true, result: GitExecResult }
		| { ok: false, failure: GitExecFailure }

export interface GitExecOptions {
	/** Kills the child and resolves `output-limit-exceeded` once either stream exceeds this many bytes. */
	maxOutputBytes?: number
	/** Aborting kills the child and resolves `{ kind: 'aborted' }`. */
	signal?: AbortSignal
}

export interface GitExecutorOptions {
	/** Base environment sanitized on every call; defaults to the live `process.env`. */
	env?: NodeJS.ProcessEnv
	/** Executable name or path; defaults to `'git'`. */
	gitPath?: string
}

export interface GitExecutor {
	/** Run a repository-independent Git command (no `-C <root>`), e.g. `--version`. */
	exec: (args: readonly string[], options?: GitExecOptions) => Promise<GitExecOutcome>
	/** Run a Git command against an explicit worktree root via `-C <root>`, independent of `process.cwd()`. */
	execIn: (root: string, args: readonly string[], options?: GitExecOptions) => Promise<GitExecOutcome>
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

function runGit(gitPath: string, envBase: NodeJS.ProcessEnv, args: readonly string[], options: GitExecOptions): Promise<GitExecOutcome> {
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

	if (options.signal?.aborted)
		return Promise.resolve({ ok: false, failure: { kind: 'aborted' } })

	return new Promise((resolve) => {
		let settled = false
		let cleanupAbortListener: (() => void) | undefined

		const settle = (outcome: GitExecOutcome): void => {
			if (settled)
				return
			settled = true
			cleanupAbortListener?.()
			resolve(outcome)
		}

		let child: ChildProcessByStdio<null, Readable, Readable>
		try {
			child = spawn(gitPath, [...args], {
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: sanitizeGitEnv(envBase),
			})
		}
		catch (error) {
			settle({ ok: false, failure: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) } })
			return
		}

		const onAbort = (): void => {
			settle({ ok: false, failure: { kind: 'aborted' } })
			child.kill('SIGTERM')
		}
		options.signal?.addEventListener('abort', onAbort, { once: true })
		cleanupAbortListener = () => options.signal?.removeEventListener('abort', onAbort)

		const stdoutChunks: Buffer[] = []
		const stderrChunks: Buffer[] = []
		let stdoutBytes = 0
		let stderrBytes = 0

		const overLimit = (stream: 'stdout' | 'stderr'): void => {
			settle({ ok: false, failure: { kind: 'output-limit-exceeded', stream, limitBytes: maxOutputBytes } })
			child.kill('SIGTERM')
		}

		child.stdout.on('data', (chunk: Buffer) => {
			if (settled)
				return
			stdoutBytes += chunk.length
			if (stdoutBytes > maxOutputBytes) {
				overLimit('stdout')
				return
			}
			stdoutChunks.push(chunk)
		})
		child.stderr.on('data', (chunk: Buffer) => {
			if (settled)
				return
			stderrBytes += chunk.length
			if (stderrBytes > maxOutputBytes) {
				overLimit('stderr')
				return
			}
			stderrChunks.push(chunk)
		})

		child.on('error', (error) => {
			settle({ ok: false, failure: { kind: 'unavailable', message: error.message } })
		})

		child.on('close', (code, signal) => {
			settle({
				ok: true,
				result: {
					stdout: Buffer.concat(stdoutChunks),
					stderr: Buffer.concat(stderrChunks),
					exitCode: code,
					signal,
				},
			})
		})
	})
}

/** Create the sole process-spawning boundary used by {@link GitRepository}. */
export function createGitExecutor(options: GitExecutorOptions = {}): GitExecutor {
	const gitPath = options.gitPath ?? 'git'
	const envBase = options.env ?? process.env

	return {
		exec(args, execOptions = {}) {
			return runGit(gitPath, envBase, args, execOptions)
		},
		execIn(root, args, execOptions = {}) {
			return runGit(gitPath, envBase, ['-C', root, ...args], execOptions)
		},
	}
}

import type { MutationResult } from '../../application/mutations'
import type { Diagnostic } from '../../domain/diagnostics'
import type { CommandOutcome } from '../command-outcome'
import { randomUUID } from 'node:crypto'
import { link, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { diagnostic } from '../../domain/diagnostics'
import { resolveWorkspaceRoot } from '../../repository/discovery'

export interface MutationCommandOptions {
	project?: string
	format: 'human' | 'json'
	noColor: boolean
}

export interface MutationCommandDeps {
	cwd: string
}

interface MutationLockOwner {
	pid: number
	nonce: string
}

interface MutationLock {
	release: () => Promise<void>
}

const MUTATION_LOCK_FILE = '.spec-tool.lock'

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	}
	catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH'
	}
}

async function readMutationLock(path: string): Promise<MutationLockOwner | undefined> {
	try {
		const value = JSON.parse(await readFile(path, 'utf8')) as Partial<MutationLockOwner>
		return Number.isInteger(value.pid) && typeof value.nonce === 'string' && value.nonce !== ''
			? { pid: value.pid!, nonce: value.nonce }
			: undefined
	}
	catch {
		return undefined
	}
}

async function reclaimStaleMutationLock(root: string, lockPath: string, owner: MutationLockOwner): Promise<boolean> {
	const claimPath = join(resolve(root), `.spec-tool-stale-${owner.nonce}.claim`)
	let claimed = false
	try {
		try {
			await link(lockPath, claimPath)
			claimed = true
		}
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'ENOENT')
				return true
			if (code !== 'EEXIST')
				throw error
			const existingClaim = await readMutationLock(claimPath)
			if (existingClaim?.nonce === owner.nonce && !isProcessAlive(existingClaim.pid)) {
				await unlink(claimPath)
					.catch(() => undefined)
				return true
			}
			return false
		}

		const claimedOwner = await readMutationLock(claimPath)
		const currentOwner = await readMutationLock(lockPath)
		if (claimedOwner?.nonce !== owner.nonce || currentOwner?.nonce !== owner.nonce)
			return false
		await unlink(lockPath)
		return true
	}
	finally {
		if (claimed) {
			await rm(claimPath, { force: true })
				.catch(() => undefined)
		}
	}
}

async function acquireMutationLock(root: string): Promise<{ lock?: MutationLock, diagnostics: Diagnostic[] }> {
	const lockPath = join(resolve(root), MUTATION_LOCK_FILE)
	const nonce = randomUUID()
	const temporary = join(resolve(root), `.spec-tool-lock-${nonce}.tmp`)
	const owner: MutationLockOwner = { pid: process.pid, nonce }
	try {
		await writeFile(temporary, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				await link(temporary, lockPath)
				return {
					lock: {
						release: async () => {
							const current = await readMutationLock(lockPath)
							if (current?.nonce === nonce) {
								await unlink(lockPath)
									.catch(() => undefined)
							}
						},
					},
					diagnostics: [],
				}
			}
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
					throw error
				const current = await readMutationLock(lockPath)
				if (current && !isProcessAlive(current.pid)) {
					if (await reclaimStaleMutationLock(root, lockPath, current))
						continue
				}
				return { diagnostics: [diagnostic('SPEC-IO-ERROR', 'Another spec mutation is already in progress for this workspace.', { path: MUTATION_LOCK_FILE })] }
			}
		}
		return { diagnostics: [diagnostic('SPEC-IO-ERROR', 'Could not acquire the Spec workspace mutation lock.', { path: MUTATION_LOCK_FILE })] }
	}
	catch (error) {
		return { diagnostics: [diagnostic('SPEC-IO-ERROR', `Could not acquire the Spec workspace mutation lock: ${(error as Error).message}.`, { path: MUTATION_LOCK_FILE })] }
	}
	finally {
		await rm(temporary, { force: true })
			.catch(() => undefined)
	}
}

export async function withWorkspaceMutationLock<T>(
	root: string,
	operation: () => Promise<MutationResult<T>>,
): Promise<MutationResult<T>> {
	const acquired = await acquireMutationLock(root)
	if (!acquired.lock)
		return { ok: false, applied: false, diagnostics: acquired.diagnostics }
	try {
		return await operation()
	}
	finally {
		await acquired.lock.release()
	}
}

export async function resolveMutationRoot(options: MutationCommandOptions, deps: MutationCommandDeps): Promise<{ root?: string, diagnostics: Diagnostic[] }> {
	const resolved = await resolveWorkspaceRoot(deps.cwd, options.project)
	return { root: resolved.root, diagnostics: resolved.diagnostics }
}

export function mutationExitCode(ok: boolean, diagnostics: readonly Diagnostic[] = []): CommandOutcome['exitCode'] {
	if (ok)
		return 0
	return diagnostics.some(item => item.code === 'SPEC-IO-ERROR' || item.code === 'SPEC-LAYOUT-INVALID' || item.code === 'SPEC-CLI-INVALID') ? 2 : 1
}

export function formatMutation<T>(format: 'human' | 'json', json: T, human: string, ok: boolean, diagnostics: readonly Diagnostic[] = []): CommandOutcome {
	return format === 'json'
		? { exitCode: mutationExitCode(ok, diagnostics), stdout: `${JSON.stringify(json)}\n`, stderr: '' }
		: { exitCode: mutationExitCode(ok, diagnostics), stdout: human, stderr: '' }
}

export async function readBodyOption(body: string | undefined, bodyFile: string | undefined, cwd: string): Promise<{ body?: string, diagnostics: Diagnostic[] }> {
	if (body !== undefined && bodyFile !== undefined)
		return { diagnostics: [diagnostic('SPEC-CLI-INVALID', 'Use either --body or --body-file, not both.', { field: 'body' })] }
	if (bodyFile === undefined)
		return { body, diagnostics: [] }
	try {
		return { body: await readFile(resolve(cwd, bodyFile), 'utf8'), diagnostics: [] }
	}
	catch (error) {
		return { diagnostics: [diagnostic('SPEC-IO-ERROR', `Could not read body file '${bodyFile}': ${(error as Error).message}.`, { path: bodyFile })] }
	}
}

export function noColor(options: MutationCommandOptions): void {
	void options.noColor
}

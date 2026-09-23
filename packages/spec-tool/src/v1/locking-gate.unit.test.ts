import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withWorkspaceReadLock, withWorkspaceWriteLock } from './write-lock'

const roots: string[] = []
async function root() {
	const directory = await mkdtemp(join(tmpdir(), 'spec-v1-lock-gate-'))
	roots.push(directory)
	return directory
}
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0)
		.map(directory => rm(directory, { recursive: true, force: true })))
})
function expireLockImmediately() {
	return vi.spyOn(Date, 'now')
		.mockReturnValueOnce(0)
		.mockReturnValue(30_001)
}

describe('fail-closed temporary lock token handling', () => {
	it('allows a diagnostic read against a missing repository root without creating an unexpected directory', async () => {
		const directory = join(await root(), 'missing')
		expect(await withWorkspaceReadLock(directory, async () => 'no-workspace'))
			.toBe('no-workspace')
		expect(existsSync(directory))
			.toBe(false)
	})

	it('rejects a stale writer token for both readers and writers without deleting it', async () => {
		const directory = await root()
		const lock = join(directory, '.spec-tool-v1.lock')
		await mkdir(lock)
		expireLockImmediately()
		await expect(withWorkspaceReadLock(directory, async () => 'unsafe'))
			.rejects.toMatchObject({
				code: 'invalid_request',
				details: { issues: [{ path: '.spec-tool-v1.lock', reason: 'conflict' }] },
			})
		vi.restoreAllMocks()
		expireLockImmediately()
		await expect(withWorkspaceWriteLock(directory, async () => 'unsafe'))
			.rejects.toMatchObject({
				code: 'invalid_request',
				details: { issues: [{ path: '.spec-tool-v1.lock', reason: 'conflict' }] },
			})
		expect(existsSync(lock))
			.toBe(true)
	})

	it('refuses to write while an abandoned reader token remains and releases its own writer lock', async () => {
		const directory = await root()
		const readers = join(directory, '.spec-tool-v1.readers')
		await mkdir(readers)
		await writeFile(join(readers, 'abandoned'), '')
		expireLockImmediately()
		await expect(withWorkspaceWriteLock(directory, async () => 'unsafe'))
			.rejects.toMatchObject({
				code: 'invalid_request',
				details: { issues: [{ path: '.spec-tool-v1.readers', reason: 'conflict' }] },
			})
		expect(existsSync(join(directory, '.spec-tool-v1.lock')))
			.toBe(false)
		expect(existsSync(join(readers, 'abandoned')))
			.toBe(true)
	})

	it('always releases reader and writer tokens after exceptions', async () => {
		const directory = await root()
		await expect(withWorkspaceReadLock(directory, async () => {
			throw new Error('reader failed')
		})).rejects.toThrow('reader failed')
		expect(existsSync(join(directory, '.spec-tool-v1.readers')))
			.toBe(false)
		await expect(withWorkspaceWriteLock(directory, async () => {
			throw new Error('writer failed')
		})).rejects.toThrow('writer failed')
		expect(existsSync(join(directory, '.spec-tool-v1.lock')))
			.toBe(false)
	})

	it('a departing reader never deletes the active second reader token directory', async () => {
		const directory = await root()
		let startFirst!: () => void
		let startSecond!: () => void
		let leaveFirst!: () => void
		let leaveSecond!: () => void
		const firstStarted = new Promise<void>(resolve => startFirst = resolve)
		const secondStarted = new Promise<void>(resolve => startSecond = resolve)
		const firstLeave = new Promise<void>(resolve => leaveFirst = resolve)
		const secondLeave = new Promise<void>(resolve => leaveSecond = resolve)
		const first = withWorkspaceReadLock(directory, async () => {
			startFirst()
			await firstLeave
		})
		const second = withWorkspaceReadLock(directory, async () => {
			startSecond()
			await secondLeave
		})
		await Promise.all([firstStarted, secondStarted])
		leaveFirst()
		await first
		expect(existsSync(join(directory, '.spec-tool-v1.readers')))
			.toBe(true)
		leaveSecond()
		await second
		expect(existsSync(join(directory, '.spec-tool-v1.readers')))
			.toBe(false)
	})
})

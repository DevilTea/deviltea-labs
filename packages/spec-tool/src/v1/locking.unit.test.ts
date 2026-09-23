import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecClient } from './client'
import { withWorkspaceReadLock, withWorkspaceWriteLock } from './write-lock'

const roots: string[] = []
async function workspace(): Promise<SpecClient> {
	const root = await mkdtemp(join(tmpdir(), 'spec-rw-lock-'))
	roots.push(root)
	const client = new SpecClient(root)
	await client.workspace.init()
	return client
}
afterEach(async () => {
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { recursive: true, force: true })))
})

describe('cross-process filesystem reader/writer coordination', () => {
	it('blocks semantic readers during a partially published multi-file write', async () => {
		const client = await workspace()
		const initial = await client.graph.export()
		const f = await client.feature.create({ title: 'First', summary: 'first', expectedRevision: initial.revision })
		const path = join(client.root, f.changedNodes[0]!.source.path)
		const previous = await readFile(path, 'utf8')
		let releaseWriter!: () => void
		let enterWriter!: () => void
		const writerEntered = new Promise<void>(resolve => enterWriter = resolve)
		const writerRelease = new Promise<void>(resolve => releaseWriter = resolve)
		const writer = withWorkspaceWriteLock(client.root, async () => {
			await writeFile(path, 'invalid transitional state')
			enterWriter()
			await writerRelease
			await writeFile(path, previous)
		})
		await writerEntered
		let settled = false
		const reader = client.graph.export()
			.then((value) => {
				settled = true
				return value
			})
		await sleep(75)
		expect(settled)
			.toBe(false)
		releaseWriter()
		await writer
		expect((await reader).revision)
			.toBe(f.revision)
		expect(existsSync(join(client.root, '.spec-tool-v1.readers')))
			.toBe(false)
	})

	it('does not let writers publish until previously admitted readers finish', async () => {
		const client = await workspace()
		let finishReader!: () => void
		let enteredReader!: () => void
		const reading = new Promise<void>(resolve => finishReader = resolve)
		const readerEntered = new Promise<void>(resolve => enteredReader = resolve)
		const reader = withWorkspaceReadLock(client.root, async () => {
			enteredReader()
			await reading
		})
		await readerEntered
		let writerEntered = false
		const writer = withWorkspaceWriteLock(client.root, async () => {
			writerEntered = true
		})
		await sleep(75)
		expect(writerEntered)
			.toBe(false)
		finishReader()
		await Promise.all([reader, writer])
		expect(writerEntered)
			.toBe(true)
		expect(existsSync(join(client.root, '.spec-tool-v1.readers')))
			.toBe(false)
	})

	it('allows concurrent readers and removes their temporary token directory', async () => {
		const client = await workspace()
		const initial = await client.graph.export()
		const revisions = await Promise.all(Array.from({ length: 36 }, async () =>
			(await client.graph.export()).revision))
		expect(revisions.every(revision => revision === initial.revision))
			.toBe(true)
		expect(existsSync(join(client.root, '.spec-tool-v1.readers')))
			.toBe(false)
		expect(existsSync(join(client.root, '.spec-tool-v1.lock')))
			.toBe(false)
	})
})

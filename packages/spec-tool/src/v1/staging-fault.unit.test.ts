import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpecClient } from './client'

const fault = vi.hoisted(() => ({ nextWrite: false, nextReaderToken: false, nextReaderBeforeCreate: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...original,
		writeFile: async (
			path: Parameters<typeof original.writeFile>[0],
			data: Parameters<typeof original.writeFile>[1],
			options?: Parameters<typeof original.writeFile>[2],
		) => {
			if (fault.nextWrite && typeof path === 'string' && path.includes('.spec-write-')) {
				fault.nextWrite = false
				// Simulate ENOSPC after the staging file was created and partly written.
				await original.writeFile(path, 'partially written secret', { flag: 'wx' })
				throw Object.assign(new Error('injected ENOSPC during stage write'), { code: 'ENOSPC' })
			}
			if (fault.nextReaderBeforeCreate && typeof path === 'string' && path.includes('.spec-tool-v1.readers/')) {
				fault.nextReaderBeforeCreate = false
				throw Object.assign(new Error('reader token failed before creation'), { code: 'EIO' })
			}
			if (fault.nextReaderToken && typeof path === 'string' && path.includes('.spec-tool-v1.readers/')) {
				fault.nextReaderToken = false
				// A token can be created before close reports EIO.
				await original.writeFile(path, '', { flag: 'wx' })
				throw Object.assign(new Error('injected reader token write failure'), { code: 'EIO' })
			}
			return original.writeFile(path, data, options)
		},
	}
})

const roots: string[] = []
afterEach(async () => {
	fault.nextWrite = false
	fault.nextReaderToken = false
	fault.nextReaderBeforeCreate = false
	await Promise.all(roots.splice(0)
		.map(root => rm(root, { force: true, recursive: true })))
})

describe('single-file staging failure cleanup', () => {
	it('removes a partial temporary staging file when writing its content throws before rename', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-v1-stage-fail-'))
		roots.push(root)
		const client = new SpecClient(root)
		await client.workspace.init()
		const before = await client.graph.export()
		fault.nextWrite = true
		await expect(client.feature.create({
			title: 'Private content',
			summary: 'Confidential specification',
			expectedRevision: before.revision,
		})).rejects.toMatchObject({ code: 'ENOSPC' })
		expect((await readdir(root)).filter(name => name.startsWith('.spec-write-')))
			.toEqual([])
		expect(await client.graph.export())
			.toEqual(before)
	})

	it('releases a partial reader registration token after token-file writing fails', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-v1-reader-token-fail-'))
		roots.push(root)
		const client = new SpecClient(root)
		await client.workspace.init()
		const before = await client.graph.export()
		fault.nextReaderToken = true
		await expect(client.workspace.validate())
			.rejects.toMatchObject({ code: 'EIO' })
		const readerPath = join(root, '.spec-tool-v1.readers')
		expect(existsSync(readerPath) ? await readdir(readerPath) : [])
			.toEqual([])
		const updated = await client.feature.create({
			title: 'No stalled writer',
			summary: 'No stale reader tokens',
			expectedRevision: before.revision,
		})
		expect(updated.changedNodes)
			.toHaveLength(1)
		expect(existsSync(readerPath))
			.toBe(false)
	})

	it('cleans the empty reader directory when token creation fails before a file exists', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spec-v1-reader-open-fail-'))
		roots.push(root)
		const client = new SpecClient(root)
		await client.workspace.init()
		fault.nextReaderBeforeCreate = true
		await expect(client.graph.export()).rejects.toMatchObject({ code: 'EIO' })
		expect(existsSync(join(root, '.spec-tool-v1.readers')))
			.toBe(false)
		const validated = await client.workspace.validate()
		expect(validated.valid)
			.toBe(true)
	})
})

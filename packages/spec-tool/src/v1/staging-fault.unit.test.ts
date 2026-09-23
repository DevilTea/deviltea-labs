import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpecClient } from './client'

const fault = vi.hoisted(() => ({ nextWrite: false }))

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
			return original.writeFile(path, data, options)
		},
	}
})

const roots: string[] = []
afterEach(async () => {
	fault.nextWrite = false
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
})

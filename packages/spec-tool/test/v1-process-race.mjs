#!/usr/bin/env node

/* Independent CLI processes must not accept the same workspace revision. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
// This integration test deliberately imports the compiled public entry.
// eslint-disable-next-line antfu/no-import-dist
import { createSpecClient } from '../dist/index.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(packageRoot, 'dist', 'cli.mjs')

function createFeature(root, expectedRevision, title) {
	return new Promise((resolveResult, reject) => {
		const child = spawn(process.execPath, [cli, 'feature', 'create', '--root', root], {
			cwd: root,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', chunk => stdout += chunk)
		child.stderr.on('data', chunk => stderr += chunk)
		child.on('error', reject)
		child.on('close', code => resolveResult({ code, stdout, stderr }))
		child.stdin.end(JSON.stringify({ title, summary: 'Concurrent write contract', expectedRevision }))
	})
}

async function main() {
	for (let attempt = 0; attempt < 8; attempt++) {
		const root = mkdtempSync(join(tmpdir(), 'spec-v1-process-race-'))
		try {
			const client = createSpecClient(root)
			const initial = await client.workspace.init()
			const [first, second] = await Promise.all([
				createFeature(root, initial.revision, 'Feature A'),
				createFeature(root, initial.revision, 'Feature B'),
			])
			const results = [first, second]
			const successes = results.filter(result => result.code === 0)
			const rejected = results.filter(result => result.code !== 0)
			assert.equal(successes.length, 1, 'exactly one CLI process should accept the revision')
			assert.equal(rejected.length, 1, 'second process must reject stale revision')
			assert.equal(JSON.parse(rejected[0].stderr).code, 'revision_conflict')
			assert.equal(rejected[0].stdout, '')
			assert.equal(JSON.parse(successes[0].stdout).changedNodes.length, 1)
			const snapshot = await client.graph.export()
			assert.equal(snapshot.data.nodes.length, 1)
			assert.equal(snapshot.revision, JSON.parse(successes[0].stdout).revision)
			assert.equal(readdirSync(join(root, '.spec', 'features')).length, 1)
			assert.equal(existsSync(join(root, '.spec-tool-v1.lock')), false, 'lock must release after mutation')
		}
		finally {
			rmSync(root, { recursive: true, force: true })
		}
	}

	process.stdout.write('ok - 8 independent CLI process races enforced one successful write and one revision_conflict each\n')
}

main()
	.catch((error) => {
		process.stderr.write(`Cross-process race test failed: ${String(error)}\n`)
		process.exitCode = 1
	})

#!/usr/bin/env node

/* Validate compiled public CLI and TS entry for Contract/Clause slice #80. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line antfu/no-import-dist
import { createSpecClient } from '../dist/index.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(packageRoot, 'dist', 'cli.mjs')
const root = mkdtempSync(join(tmpdir(), 'spec-contract-smoke-'))
let assertions = 0

function check(actual, expected, name) {
	assert.deepEqual(actual, expected, name)
	assertions++
}
function run(resource, operation, input = {}) {
	const proc = spawnSync(process.execPath, [cli, resource, operation, '--root', root], {
		input: JSON.stringify(input),
		encoding: 'utf8',
		cwd: root,
		timeout: 10000,
	})
	if (proc.error)
		throw proc.error
	const success = proc.status === 0
	check(success ? proc.stderr : proc.stdout, '', `${resource}/${operation} emits only on its documented channel`)
	return { success, code: proc.status, result: JSON.parse(success ? proc.stdout : proc.stderr) }
}

async function main() {
	try {
		const client = createSpecClient(root)
		let result = run('workspace', 'init')
		check(result.success, true, 'workspace init')
		let revision = result.result.revision
		const featureA = run('feature', 'create', {
			title: 'Alpha',
			summary: 'Alpha functionality',
			expectedRevision: revision,
		})
		const a = featureA.result.changedNodes[0].id
		revision = featureA.result.revision
		const featureB = run('feature', 'create', {
			title: 'Beta',
			summary: 'Beta functionality',
			expectedRevision: revision,
		})
		const b = featureB.result.changedNodes[0].id
		revision = featureB.result.revision
		result = run('contract', 'create', {
			title: 'Global',
			summary: 'Shared authority',
			constrains: [a],
			expectedRevision: revision,
		})
		check(result.success, true, 'contract create')
		const contractId = result.result.changedNodes[0].id
		check(result.result.changedEdges.added, [{ from: contractId, type: 'constrains', to: a }], 'contract constrains Feature')
		const contractPath = join(root, `.spec/contracts/${contractId}.md`)
		check(existsSync(contractPath), true, 'canonical standalone persistence')
		check(readFileSync(contractPath, 'utf8')
			.includes('clauses: []\nconstrains:\n'), true, 'Contract frontmatter canonical field order')
		revision = result.result.revision
		const secondContract = run('contract', 'create', {
			title: 'Specific',
			summary: 'Another authority',
			constrains: [b],
			expectedRevision: revision,
		})
		const contractB = secondContract.result.changedNodes[0].id
		revision = secondContract.result.revision
		result = run('clause', 'create', {
			ownerId: contractId,
			statement: 'Inherited constraint',
			expectedRevision: revision,
		})
		check(result.success, true, 'inherited Clause create')
		const clauseId = result.result.changedNodes[0].id
		check(result.result.changedEdges.added, [{ from: clauseId, type: 'constrains', to: a }], 'inherit materializes effective edge')
		revision = result.result.revision
		result = run('graph', 'set-relation-targets', {
			sourceId: contractId,
			type: 'constrains',
			targets: [b],
			expectedRevision: revision,
		})
		check(result.result.changedEdges.added.length, 2, 'Contract scope changes derived Clause edge')
		check(result.result.changedEdges.removed.length, 2, 'old effective scope removed')
		revision = result.result.revision
		const sameTargets = run('graph', 'set-relation-targets', {
			sourceId: clauseId,
			type: 'constrains',
			targets: [b],
			expectedRevision: revision,
		})
		check(sameTargets.result.revision, revision, 'semantically equivalent explicit override keeps revision')
		check(sameTargets.result.changedNodes, [], 'override does not change normalized Clause node')
		revision = sameTargets.result.revision
		result = run('graph', 'set-relation-targets', {
			sourceId: clauseId,
			type: 'constrains',
			targets: [a],
			expectedRevision: revision,
		})
		check(result.result.changedEdges, {
			added: [{ from: clauseId, type: 'constrains', to: a }],
			removed: [{ from: clauseId, type: 'constrains', to: b }],
		}, 'Clause override replaces rather than unions effective scope')
		revision = result.result.revision
		result = run('graph', 'set-relation-targets', {
			sourceId: clauseId,
			type: 'constrains',
			targets: null,
			expectedRevision: revision,
		})
		check(result.result.changedEdges.added, [{ from: clauseId, type: 'constrains', to: b }], 'Clause null restores inherited scope')
		revision = result.result.revision
		check(readFileSync(contractPath, 'utf8')
			.includes('    constrains:'), false, 'Clause inheritance is represented by field absence')
		result = run('clause', 'reparent', {
			id: clauseId,
			newOwnerId: contractB,
			expectedRevision: revision,
		})
		check(result.result.changedNodes[0].ownerId, contractB, 'Clause identity survives reparent')
		revision = result.result.revision
		check((await client.graph.get({ id: clauseId })).data.ownerId, contractB, 'compiled TypeScript client reads CLI reparent')
		check((await client.graph.incoming({ id: b, type: 'constrains' })).data.length, 3, 'compiled graph includes Contract and Clause effective edges')
		const invalid = run('clause', 'create', {
			ownerId: contractB,
			statement: 'Invalid override',
			constrains: [],
			expectedRevision: revision,
		})
		check(invalid.success, false, 'reject empty Clause override')
		check(invalid.result.code, 'relation_invalid', 'stable structured error envelope')
		const stale = run('clause', 'delete', { id: clauseId, expectedRevision: featureA.result.revision })
		check(stale.success, false, 'reject stale revision')
		const removed = run('clause', 'delete', { id: clauseId, expectedRevision: revision })
		check(removed.result.deletedIds, [clauseId], 'Clause deletion')
		revision = removed.result.revision
		const firstDeleted = run('contract', 'delete', { id: contractId, expectedRevision: revision })
		check(firstDeleted.result.deletedIds, [contractId], 'standalone Contract deletion')
		check(existsSync(contractPath), false, 'canonical file removed')
		check((await client.workspace.validate()).valid, true, 'persisted workspace valid through TS client')
		check(existsSync(join(root, '.spec-tool-v1.readers')), false, 'reader tokens cleaned')
		check(existsSync(join(root, '.spec-tool-v1.lock')), false, 'writer lock cleaned')
		process.stdout.write(`ok - v1 built CLI/TS Contract + Clause smoke: ${assertions} assertions passed\n`)
	}
	finally {
		rmSync(root, { recursive: true, force: true })
	}
}

main()
	.catch((error) => {
		process.stderr.write(`v1 contract smoke failed: ${String(error)}\n`)
		process.exitCode = 1
	})

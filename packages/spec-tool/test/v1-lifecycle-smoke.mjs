#!/usr/bin/env node

/* Public compiled CLI/TypeScript parity for explicit cross-kind lifecycle. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line antfu/no-import-dist
import { createSpecClient } from '../dist/index.mjs'

const root = mkdtempSync(join(tmpdir(), 'spec-v1-lifecycle-smoke-'))
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.mjs')
let assertions = 0

function check(actual, expected, label) {
	assert.deepEqual(actual, expected, label)
	assertions++
}
function run(resource, operation, input = {}) {
	const child = spawnSync(process.execPath, [cli, resource, operation, '--root', root], {
		cwd: root,
		input: JSON.stringify(input),
		encoding: 'utf8',
		timeout: 10000,
	})
	if (child.error)
		throw child.error
	const success = child.status === 0
	check(success ? child.stderr : child.stdout, '', `${resource}/${operation} uses its documented output channel`)
	return { success, result: JSON.parse(success ? child.stdout : child.stderr) }
}

async function main() {
	try {
		const client = createSpecClient(root)
		const init = run('workspace', 'init')
		const f = run('feature', 'create', {
			title: 'Alpha',
			summary: 'Alpha',
			expectedRevision: init.result.revision,
		})
		const a = f.result.changedNodes[0].id
		const g = run('feature', 'create', {
			title: 'Beta',
			summary: 'Beta',
			expectedRevision: f.result.revision,
		})
		const b = g.result.changedNodes[0].id
		const rule = run('rule', 'create', {
			ownerId: a,
			statement: 'Promote this Rule',
			expectedRevision: g.result.revision,
		})
		const rid = rule.result.changedNodes[0].id
		const contract = run('contract', 'create', {
			title: 'Shared authority',
			summary: 'Crosses Features',
			constrains: [a],
			expectedRevision: rule.result.revision,
		})
		const cid = contract.result.changedNodes[0].id
		const policy = run('clause', 'create', {
			ownerId: cid,
			statement: 'References original Rule',
			constrains: [rid],
			expectedRevision: contract.result.revision,
		})
		const policyId = policy.result.changedNodes[0].id
		const before = await client.graph.export()
		const blocked = run('rule', 'promote', {
			id: rid,
			newOwnerId: cid,
			relations: { constrains: null },
			expectedRevision: before.revision,
		})
		check(blocked.success, false, 'inbound Clause constraint blocks Rule promotion')
		check(blocked.result.code, 'relation_invalid', 'final-state invalid reference classified')
		check(blocked.result.details.reason, 'target_kind', 'final target kind incompatibility')
		check(await client.graph.export(), before, 'failed cross-kind operation leaves original snapshot unchanged')
		const release = run('graph', 'set-relation-targets', {
			sourceId: policyId,
			type: 'constrains',
			targets: null,
			expectedRevision: before.revision,
		})
		check(release.success, true, 'explicitly release original Rule target')
		check(release.result.changedEdges.removed, [{ from: policyId, type: 'constrains', to: rid }], 'old Clause Rule edge explicitly removed')
		const promoted = run('rule', 'promote', {
			id: rid,
			newOwnerId: cid,
			relations: { constrains: null },
			expectedRevision: release.result.revision,
		})
		check(promoted.success, true, 'Rule promoted after illegal references resolved')
		check(promoted.result.changedNodes[0].id, rid, 'stable UUID through promotion')
		check(promoted.result.changedNodes[0].kind, 'clause', 'Rule converted into Clause')
		check(promoted.result.changedEdges.added, [{ from: rid, type: 'constrains', to: a }], 'new Clause inherited Contract scope')
		check((await client.graph.get({ id: rid })).data.ownerId, cid, 'TypeScript graph sees promoted Clause')
		const contractPath = join(root, `.spec/contracts/${cid}.md`)
		const file = readFileSync(contractPath, 'utf8')
		check(file.indexOf(policyId) < file.indexOf(rid), true, 'promotion appends at new owner tail')
		check(file.includes('    constrains:'), false, 'both Clauses inherit via absent override')
		const invalid = run('clause', 'demote', {
			id: rid,
			newOwnerId: b,
			relations: { constrains: null },
			expectedRevision: promoted.result.revision,
		})
		check(invalid.success, false, 'demotion requires explicit empty final relations')
		check(invalid.result.code, 'invalid_request', 'extra Clause-only relation keys rejected')
		const demoted = run('clause', 'demote', {
			id: rid,
			newOwnerId: b,
			relations: {},
			expectedRevision: promoted.result.revision,
		})
		check(demoted.success, true, 'Clause demoted after explicit final empty relation declaration')
		check(demoted.result.changedNodes[0].id, rid, 'stable UUID through demotion')
		check(demoted.result.changedNodes[0].kind, 'rule', 'Clause converted into Rule')
		check(demoted.result.changedEdges.removed, [{ from: rid, type: 'constrains', to: a }], 'Clause-only effective edge removed explicitly')
		const scenario = run('scenario', 'create', {
			title: 'Demonstrates converted Rule',
			steps: [{ type: 'when', text: 'run operation' }, { type: 'then', text: 'receive result' }],
			demonstrates: [rid],
			expectedRevision: demoted.result.revision,
		})
		const sid = scenario.result.changedNodes[0].id
		check((await client.graph.outgoing({ id: sid })).data, [{ from: sid, type: 'demonstrates', to: rid }], 'Scenario reference survives kind transition')
		const missing = run('feature', 'delete-with-children', {
			ownerId: b,
			childIds: [],
			expectedRevision: scenario.result.revision,
		})
		check(missing.result.code, 'invalid_request', 'compound delete requires complete child set')
		const guarded = run('feature', 'delete-with-children', {
			ownerId: b,
			childIds: [rid],
			expectedRevision: scenario.result.revision,
		})
		check(guarded.result.code, 'referenced_unit', 'Scenario inbound edge prevents compound child deletion')
		const deletedScenario = run('scenario', 'delete', {
			id: sid,
			expectedRevision: scenario.result.revision,
		})
		const featureGone = run('feature', 'delete-with-children', {
			ownerId: b,
			childIds: [rid],
			expectedRevision: deletedScenario.result.revision,
		})
		check(featureGone.success, true, 'Feature and listed Rule deleted together')
		check(featureGone.result.deletedIds, [b, rid].sort(), 'compound Feature deletion exposes full deleted ID set')
		check(existsSync(join(root, `.spec/features/${b}.md`)), false, 'Feature owner file deleted')
		const policyScenario = run('scenario', 'create', {
			title: 'Contract is still referenced',
			steps: [{ type: 'when', text: 'request' }, { type: 'then', text: 'respond' }],
			demonstrates: [cid],
			expectedRevision: featureGone.result.revision,
		})
		const contractGuard = run('contract', 'delete-with-children', {
			ownerId: cid,
			childIds: [policyId],
			expectedRevision: policyScenario.result.revision,
		})
		check(contractGuard.result.code, 'referenced_unit', 'Contract inbound relation blocks compound teardown')
		const releasePolicy = run('scenario', 'delete', {
			id: policyScenario.result.changedNodes[0].id,
			expectedRevision: policyScenario.result.revision,
		})
		const contractGone = run('contract', 'delete-with-children', {
			ownerId: cid,
			childIds: [policyId],
			expectedRevision: releasePolicy.result.revision,
		})
		check(contractGone.success, true, 'Contract and listed Clause deleted together')
		check(contractGone.result.deletedIds, [cid, policyId].sort(), 'compound Contract deleted IDs complete')
		check(contractGone.result.changedEdges.removed.length, 2, 'Contract and inherited Clause edges removed')
		check(existsSync(contractPath), false, 'Contract owner file deleted')
		check((await client.workspace.validate()).valid, true, 'workspace remains valid after conversion/teardown')
		check((await client.graph.export()).data.nodes.map(node => node.id), [a], 'only unrelated Feature survives')
		check(existsSync(join(root, '.spec-tool-v1.readers')), false, 'reader tokens cleaned')
		check(existsSync(join(root, '.spec-tool-v1.lock')), false, 'writer lock cleaned')
		process.stdout.write(`ok - v1 built CLI/TS cross-kind lifecycle smoke: ${assertions} assertions passed\n`)
	}
	finally {
		rmSync(root, { recursive: true, force: true })
	}
}

main()
	.catch((error) => {
		process.stderr.write(`v1 cross-kind lifecycle smoke failed: ${String(error)}\n`)
		process.exitCode = 1
	})

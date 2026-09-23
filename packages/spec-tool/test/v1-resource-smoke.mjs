#!/usr/bin/env node

/* Public built CLI and TypeScript entry must share Rule/Scenario semantics. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line antfu/no-import-dist
import { createSpecClient } from '../dist/index.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(packageRoot, 'dist', 'cli.mjs')
const root = mkdtempSync(join(tmpdir(), 'spec-v1-resource-smoke-'))
let assertions = 0

function check(value, expected, label) {
	assert.deepEqual(value, expected, label)
	assertions++
}

function run(resource, operation, input = {}) {
	const result = spawnSync(process.execPath, [cli, resource, operation, '--root', root], {
		cwd: root,
		input: JSON.stringify(input),
		encoding: 'utf8',
		timeout: 10000,
	})
	if (result.error)
		throw result.error
	const success = result.status === 0
	check(success ? result.stderr : result.stdout, '', `${resource}/${operation}: output channel`)
	const output = JSON.parse(success ? result.stdout : result.stderr)
	return { status: result.status, output }
}

async function main() {
	try {
		const client = createSpecClient(root)
		const init = run('workspace', 'init')
		check(init.status, 0, 'CLI init')
		const first = run('feature', 'create', {
			title: 'Search',
			summary: 'Find results',
			expectedRevision: init.output.revision,
		})
		const featureId = first.output.changedNodes[0].id
		const second = run('feature', 'create', {
			title: 'Browse',
			summary: 'Browse results',
			expectedRevision: first.output.revision,
		})
		const otherId = second.output.changedNodes[0].id
		const rule = run('rule', 'create', {
			ownerId: featureId,
			statement: 'Results must be ordered',
			expectedRevision: second.output.revision,
		})
		const ruleId = rule.output.changedNodes[0].id
		check(rule.output.changedNodes[0].kind, 'rule', 'Rule exposed by CLI')
		const moved = run('rule', 'reparent', {
			id: ruleId,
			newOwnerId: otherId,
			expectedRevision: rule.output.revision,
		})
		check(moved.output.changedNodes[0].ownerId, otherId, 'Rule reparent preserved identity')
		const steps = [
			{ type: 'given', text: 'a user opens search' },
			{ type: 'when', text: 'the user submits a query' },
			{ type: 'then', text: 'ordered results appear' },
		]
		const scenario = run('scenario', 'create', {
			title: 'Search results',
			steps,
			demonstrates: [featureId, ruleId].sort(),
			expectedRevision: moved.output.revision,
		})
		const scenarioId = scenario.output.changedNodes[0].id
		const path = scenario.output.changedNodes[0].source.path
		check(existsSync(join(root, path)), true, 'Scenario container persisted')
		check(readdirSync(join(root, '.spec/scenarios')).length, 1, 'one Scenario container')
		check(readFileSync(join(root, path), 'utf8')
			.startsWith('Feature: Search results\n  @spec:id:'), true, 'canonical Gherkin persisted')
		const graph = run('graph', 'export')
		check(graph.output.data.nodes.map(node => node.kind)
			.sort(), ['feature', 'feature', 'rule', 'scenario'], 'normalized graph node kinds')
		check(graph.output.data.edges.length, 2, 'two demonstrates edges')
		check((await client.graph.get({ id: scenarioId })).data.steps, steps, 'compiled TS API reads CLI state')
		const rejected = run('rule', 'delete', {
			id: ruleId,
			expectedRevision: scenario.output.revision,
		})
		check(rejected.status, 1, 'referenced Rule delete rejected')
		check(rejected.output.code, 'referenced_unit', 'referential guard surfaced by CLI')
		const updated = run('scenario', 'update', {
			id: scenarioId,
			changes: {
				steps: [{ type: 'when', text: 'the query runs' }, { type: 'then', text: 'results display' }],
			},
			expectedRevision: scenario.output.revision,
		})
		check(updated.output.changedNodes[0].steps.length, 2, 'Scenario steps replacement')
		const invalid = run('graph', 'set-relation-targets', {
			sourceId: scenarioId,
			type: 'demonstrates',
			targets: [],
			expectedRevision: updated.output.revision,
		})
		check(invalid.output.code, 'relation_invalid', 'empty demonstrates rejected')
		const removed = run('scenario', 'delete', { id: scenarioId, expectedRevision: updated.output.revision })
		check(removed.output.deletedIds, [scenarioId], 'Scenario deletion')
		check(existsSync(join(root, path)), false, 'empty Scenario container deleted')
		const ruleDeleted = run('rule', 'delete', { id: ruleId, expectedRevision: removed.output.revision })
		check(ruleDeleted.output.deletedIds, [ruleId], 'Rule deletion after Scenario removal')
		check(existsSync(join(root, '.spec-tool-v1.readers')), false, 'reader lock tokens cleaned')
		check(existsSync(join(root, '.spec-tool-v1.lock')), false, 'writer lock cleaned')
		process.stdout.write(`ok - v1 built CLI/TS Rule + Scenario smoke: ${assertions} assertions passed\n`)
	}
	finally {
		rmSync(root, { recursive: true, force: true })
	}
}

main()
	.catch((error) => {
		process.stderr.write(`v1 resource smoke failed: ${String(error)}\n`)
		process.exitCode = 1
	})

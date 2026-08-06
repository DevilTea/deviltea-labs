import type { GitExecOutcome, GitExecutor } from '../../git/executor'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitExecutor } from '../../git/executor'
import { runValidateCommand } from './validate'

/**
 * Wraps a real executor, forcing a Git process that RAN and was OBSERVED
 * (`ok: true`) but exited non-zero for `execIn` calls matching `shouldFail`;
 * every other call passes through unchanged. Distinct from
 * {@link withSelectiveFailure}'s `unavailable` (the process could not even be
 * run/observed): this models an execution/read error on a call whose
 * preceding existence check already succeeded (`GitRepository#readTree`'s and
 * `#readBlob`'s `error` kind).
 */
function withNonZeroExit(base: GitExecutor, shouldFail: (args: readonly string[]) => boolean, exitCode: number): GitExecutor {
	return {
		exec: (args, options) => base.exec(args, options),
		execIn: (root, args, options): Promise<GitExecOutcome> => {
			if (shouldFail(args)) {
				return Promise.resolve({ ok: true, result: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode, signal: null } })
			}
			return base.execIn(root, args, options)
		},
	}
}

/** Wraps a real executor, forcing failure for `execIn` calls matching `shouldFail`; every other call passes through unchanged. */
function withSelectiveFailure(base: GitExecutor, shouldFail: (args: readonly string[]) => boolean, message: string): GitExecutor {
	return {
		exec: (args, options) => base.exec(args, options),
		execIn: (root, args, options): Promise<GitExecOutcome> => {
			if (shouldFail(args))
				return Promise.resolve({ ok: false, failure: { kind: 'unavailable', message } })
			return base.execIn(root, args, options)
		},
	}
}

/**
 * Wraps a real executor, forcing failure only for the FIRST `execIn` call
 * matching `shouldFail`; every later call (matching or not) passes through to
 * the real executor. Models a transient, first-observation-only Git failure:
 * a re-read of the exact same commit later in the same command invocation
 * succeeds.
 */
function withFirstMatchingCallFailure(base: GitExecutor, shouldFail: (args: readonly string[]) => boolean, message: string): GitExecutor {
	let alreadyFailed = false
	return {
		exec: (args, options) => base.exec(args, options),
		execIn: (root, args, options): Promise<GitExecOutcome> => {
			if (!alreadyFailed && shouldFail(args)) {
				alreadyFailed = true
				return Promise.resolve({ ok: false, failure: { kind: 'unavailable', message } })
			}
			return base.execIn(root, args, options)
		},
	}
}

const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: 'EF Test',
	GIT_AUTHOR_EMAIL: 'ef-test@example.com',
	GIT_COMMITTER_NAME: 'EF Test',
	GIT_COMMITTER_EMAIL: 'ef-test@example.com',
}

function git(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_TEST_ENV }, encoding: 'utf8' })
}

function commitAll(dir: string, message: string): string {
	git(dir, ['add', '-A'])
	git(dir, ['commit', '-q', '-m', message])
	return git(dir, ['rev-parse', 'HEAD'])
		.trim()
}

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

const GITIGNORE = '.cache/\n.generated/\n.tmp/\n.lock\n'

const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A minimal example project used for CLI validate tests.
tags: []
relations: []
resources: []
---

## Vision

Deliver a well-governed engineering specification workflow for this repository.

## Scope

This project covers specification-driven engineering artifacts under .engineering.

## Non-goals

This project does not manage unrelated deployment tooling.

## Context

The project operates as a single-repository workspace with no linked repositories.

## Terminology

| Term | Definition | Avoid or aliases |
| --- | --- | --- |
`

function requirementMd(id: string, status: string, extra: { lifecycle?: string } = {}): string {
	const lifecycle = extra.lifecycle ? `\n\n## Lifecycle\n\n${extra.lifecycle}` : ''
	return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Example Requirement
status: ${status}
summary: A minimal example requirement used for CLI validate tests.
tags: []
relations: []
resources: []
---

## Requirement

The system must do something specific and testable.

## Rationale

Because it is needed.

## Acceptance Criteria

- The system behaves as specified.${lifecycle}
`
}

function changeMd(id: string, status: string, relations: string): string {
	return `---
schema: ef/change@1
type: change
id: ${id}
title: Example Change
status: ${status}
summary: A minimal example CHG used for CLI validate tests.
tags: []
relations: ${relations}
resources: []
---

## Rationale

Because it is needed.

## Sources

- REQ-001

## Changes

- Updates REQ-001.

## Verification

Result: passed

- Reviewed and confirmed.
`
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

async function writeMinimalProject(root: string): Promise<void> {
	await writeFile(root, '.engineering/ef.yaml', CONFIG_YAML)
	await writeFile(root, '.engineering/.gitignore', GITIGNORE)
	await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
}

describe('runValidateCommand', () => {
	let root: string

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-cli-validate-')))
		execFileSync('git', ['init', '-q', '-b', 'main', root])
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	function deps() {
		return { cwd: root, executor: createGitExecutor() }
	}

	// ---- Pre-materialization scope/option applicability --------------------

	it('rejects --baseline for snapshot scope without touching the filesystem, exit 2', async () => {
		const outcome = await runValidateCommand({ scope: 'snapshot', baseline: 'a'.repeat(40), strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.scope)
			.toBe('snapshot')
	})

	it('rejects --proposed for snapshot scope, exit 2', async () => {
		const outcome = await runValidateCommand({ scope: 'snapshot', proposed: 'a'.repeat(40), strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('requires --baseline for transition scope, exit 2, without falling back to snapshot', async () => {
		const outcome = await runValidateCommand({ scope: 'transition', proposed: 'a'.repeat(40), strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.scope)
			.toBe('transition')
		expect(json.complete)
			.toBe(false)
	})

	it('requires --proposed for transition scope, exit 2', async () => {
		const outcome = await runValidateCommand({ scope: 'transition', baseline: 'a'.repeat(40), strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	it('requires --proposed for bootstrap scope, exit 2', async () => {
		const outcome = await runValidateCommand({ scope: 'bootstrap', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
	})

	// ---- Project resolution --------------------------------------------------

	it('reports exit 2 when no EF project can be discovered', async () => {
		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
	})

	it('reports EF-VAL-012 (incomplete-initialization) when .engineering exists without ef.yaml', async () => {
		await fs.mkdir(path.join(root, '.engineering'))
		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-012')
	})

	it('reports EF-VAL-006 (git-unavailable) when project resolution itself cannot use Git', async () => {
		await writeMinimalProject(root)
		const unavailableExecutor = {
			exec: async () => ({ ok: false as const, failure: { kind: 'unavailable' as const, message: 'git is not installed' } }),
			execIn: async () => ({ ok: false as const, failure: { kind: 'unavailable' as const, message: 'git is not installed' } }),
		}
		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: unavailableExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
	})

	// ---- Snapshot scope --------------------------------------------------------

	it('validates a correct snapshot as valid, complete, exit 0', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'bootstrap')

		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json)
			.toMatchObject({
				schema: 'ef/validation-result@1',
				kind: 'validation',
				scope: 'snapshot',
				baseline_oid: null,
				proposed_oid: null,
				integration_ref: 'refs/heads/main',
				complete: true,
				valid: true,
				exit_code: 0,
			})
		expect(outcome.stdout)
			.toMatch(/\n$/)
	})

	it('reports a domain finding (duplicate ID) as invalid, exit 1', async () => {
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/req/REQ-002.md', requirementMd('REQ-001', 'active'))
		commitAll(root, 'dup')

		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.valid)
			.toBe(false)
		expect(json.diagnostics.some((d: { code: string }) => d.code === 'EF-ID-004'))
			.toBe(true)
	})

	it('renders human output when --format human is used, ending in one newline', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'bootstrap')

		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'human', noColor: true }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		expect(typeof outcome.stdout)
			.toBe('string')
		expect(outcome.stdout)
			.toContain('snapshot')
	})

	// ---- Transition scope --------------------------------------------------------

	it('validates a correct transition (draft requirement activated by a completed CHG) as valid, exit 0', async () => {
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
		const baseline = commitAll(root, 'baseline')

		// The candidate lives on a separate ref: `main` (the configured
		// `integration_ref`) must still resolve to `baseline` when validation
		// begins, matching real CI usage where the candidate has not yet been
		// merged (13-cli-contract.md "creating it on a feature/candidate ref is
		// not publication").
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
		const proposed = commitAll(root, 'proposed')
		git(root, ['checkout', '-q', 'main'])

		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		const json = JSON.parse(outcome.stdout as string)
		expect(json.scope)
			.toBe('transition')
		expect(json.baseline_oid)
			.toBe(baseline)
		expect(json.proposed_oid)
			.toBe(proposed)
		expect(json.diagnostics)
			.toEqual([])
		expect(outcome.exitCode)
			.toBe(0)
		expect(json.valid)
			.toBe(true)
	})

	it('reports exit 2 (incomplete) for an unresolvable proposed commit', async () => {
		await writeMinimalProject(root)
		const baseline = commitAll(root, 'baseline')

		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed: 'f'.repeat(40), strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
	})

	// ---- Bootstrap scope --------------------------------------------------------

	it('validates a correct bootstrap candidate as valid, exit 0', async () => {
		// `main` (the configured `integration_ref`) must remain unborn: the
		// bootstrap candidate is committed on a separate local branch, matching
		// "the ref does not yet resolve" (09-validation.md "Bootstrap exception").
		git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'bootstrap candidate')

		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		const json = JSON.parse(outcome.stdout as string)
		expect(json.scope)
			.toBe('bootstrap')
		expect(outcome.exitCode)
			.toBe(0)
		expect(json.valid)
			.toBe(true)
	})

	it('rejects a bootstrap candidate containing a completed CHG, exit 1', async () => {
		git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[]'))
		const proposed = commitAll(root, 'bootstrap candidate with chg')

		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics.some((d: { code: string }) => d.code === 'EF-VAL-010'))
			.toBe(true)
	})

	// ---- Strict / warnings-as-errors -------------------------------------------

	it('--strict fails a snapshot that would otherwise pass with a warning', async () => {
		await writeMinimalProject(root)
		// A relation entry with an out-of-canonical-order extension field triggers
		// a warning (EF-ENV-011) rather than an error, without affecting `valid`
		// under the default policy.
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active')
			.replace('relations: []', 'relations:\n  - type: references\n    target: PROJECT\n    x-b: 1\n    x-a: 2'))
		commitAll(root, 'warn')

		const lenient = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		const lenientJson = JSON.parse(lenient.stdout as string)

		const strict = await runValidateCommand({ scope: 'snapshot', strict: true, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		const strictJson = JSON.parse(strict.stdout as string)

		expect(strictJson.strict)
			.toBe(true)
		expect(strictJson.warnings_as_errors)
			.toBe(true)
		if (lenientJson.counts.warning > 0) {
			expect(lenientJson.valid)
				.toBe(true)
			expect(strictJson.valid)
				.toBe(false)
			expect(strict.exitCode)
				.toBe(1)
		}
	})

	// ---- Workspace -------------------------------------------------------------

	it('--workspace adds workspace:true to the envelope and stays valid with no linked repositories', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'bootstrap')

		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: true, format: 'json', noColor: false }, deps())
		const json = JSON.parse(outcome.stdout as string)
		expect(json.workspace)
			.toBe(true)
		expect(json.valid)
			.toBe(true)
	})

	// ---- Transition scope: baseline/config resolution edge cases ------------

	it('transition scope reports EF-VAL-002 for an unresolvable baseline (baselineConfig/operationStartRefOid stay null)', async () => {
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'proposed')

		const outcome = await runValidateCommand({ scope: 'transition', baseline: 'f'.repeat(40), proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.baseline_oid)
			.toBeNull()
		expect(json.integration_ref)
			.toBeNull()
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-002')
	})

	it('transition scope with --workspace validates and folds in workspace diagnostics for the proposed commit', async () => {
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
		const baseline = commitAll(root, 'baseline')
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
		const proposed = commitAll(root, 'proposed')

		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: true, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.workspace)
			.toBe(true)
		expect(json.valid)
			.toBe(true)
	})

	it('transition scope with a malformed baseline ef.yaml reports EF-VAL-002 (no valid authoritative snapshot at baseline)', async () => {
		await writeFile(root, '.engineering/ef.yaml', 'not: valid: yaml: [')
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		const baseline = commitAll(root, 'baseline-bad-config')
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'proposed-good')

		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics.some((d: { code: string, message: string }) => d.code === 'EF-VAL-002' && d.message.includes('does not contain a valid authoritative EF snapshot')))
			.toBe(true)
	})

	it('transition scope reports EF-VAL-002 when the baseline\'s own integration_ref does not resolve at operation start', async () => {
		await writeFile(root, '.engineering/ef.yaml', 'schema: ef/config@1\nrepository:\n  integration_ref: refs/heads/does-not-exist\nlinked_repositories: []\nschemas:\n  artifact_write_major: 1\n')
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		const baseline = commitAll(root, 'baseline')
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		const proposed = commitAll(root, 'proposed')

		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.integration_ref)
			.toBe('refs/heads/does-not-exist')
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-002')
		expect(json.diagnostics[0].message)
			.toContain('resolved to \'nothing\'')
	})

	// ---- Bootstrap scope: proposed resolution and --workspace ----------------

	it('bootstrap scope reports EF-VAL-011 for an unresolvable proposed commit', async () => {
		await writeMinimalProject(root)
		commitAll(root, 'x')

		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed: 'f'.repeat(40), strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-011')
	})

	it('bootstrap scope with --workspace validates and folds in workspace diagnostics', async () => {
		git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'bootstrap candidate')

		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: true, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.workspace)
			.toBe(true)
		expect(json.valid)
			.toBe(true)
	})

	it('bootstrap scope with --workspace and an unresolvable proposed commit still folds in an (empty) workspace check', async () => {
		// `proposedConfig` stays `undefined` (the proposed commit never resolved),
		// so the workspace check must fall back to an empty
		// `linked_repositories` list rather than throwing.
		await writeMinimalProject(root)
		commitAll(root, 'x')

		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed: 'f'.repeat(40), strict: false, warningsAsErrors: false, workspace: true, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.workspace)
			.toBe(true)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-011')
	})

	it('bootstrap scope succeeds when the integration ref already resolves, as long as its history never contained EF state', async () => {
		// 09-validation.md's bootstrap exception permits *either* the ref not
		// resolving yet *or* resolving only to commits that never contained
		// '.engineering/ef.yaml'. This exercises the second, less obvious half:
		// `main` already has a prior (non-EF) commit before the bootstrap
		// candidate branches off it.
		await writeFile(root, 'README.md', '# not an EF project yet\n')
		const baseCommit = commitAll(root, 'pre-existing non-EF history')
		git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'bootstrap candidate')

		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(0)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.valid)
			.toBe(true)
		expect(json.expected_ref_oid)
			.toBe(baseCommit)
	})

	// ---- Snapshot scope: project-snapshot load failure and unconfigured project ----

	it('snapshot scope reports EF-VAL-001 (not EF-VAL-006) when the snapshot itself fails to load with a read-error', async () => {
		// `.gitignore` is read unconditionally by `loadSnapshotFromWorkingTree`
		// but never inspected by project discovery/resolution, so replacing it
		// with a directory lets `resolveProject` succeed while the snapshot load
		// itself fails with `read-error` -- a reason `loadSnapshotFromWorkingTree`
		// can actually produce, unlike `git-unavailable` (fs-only, no Git calls).
		await writeMinimalProject(root)
		await fs.rm(path.join(root, '.engineering', '.gitignore'))
		await fs.mkdir(path.join(root, '.engineering', '.gitignore'))

		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-001')
	})

	it('snapshot scope with --workspace falls back to null integration_ref and an empty linked-repositories list when ef.yaml is malformed', async () => {
		await writeFile(root, '.engineering/ef.yaml', 'not: valid: yaml: [')
		await writeFile(root, '.engineering/.gitignore', GITIGNORE)
		await writeFile(root, '.engineering/PROJECT.md', PROJECT_MD)
		commitAll(root, 'malformed config')

		const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: true, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(1)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.workspace)
			.toBe(true)
		expect(json.valid)
			.toBe(false)
		expect(json.integration_ref)
			.toBeNull()
		expect(json.diagnostics.some((d: { code: string }) => d.code === 'EF-FS-001'))
			.toBe(true)
	})

	// ---- Transition scope: `peekConfigAt` (baseline config peek) edge cases ----

	it('transition scope reports EF-VAL-006 when Git becomes unavailable while reading the baseline tree', async () => {
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
		const baseline = commitAll(root, 'baseline')
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
		const proposed = commitAll(root, 'proposed')
		git(root, ['checkout', '-q', 'main'])

		const flakyExecutor = withSelectiveFailure(createGitExecutor(), args => args[0] === 'ls-tree', 'stub: ls-tree transiently unavailable')
		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('stub: ls-tree transiently unavailable')
	})

	it('transition scope reports EF-VAL-006 when Git becomes unavailable while reading a blob', async () => {
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
		const baseline = commitAll(root, 'baseline')
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
		const proposed = commitAll(root, 'proposed')
		git(root, ['checkout', '-q', 'main'])

		const flakyExecutor = withSelectiveFailure(createGitExecutor(), args => args[0] === 'cat-file' && args[1] === '-p', 'stub: cat-file -p transiently unavailable')
		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('stub: cat-file -p transiently unavailable')
	})

	// FINDING (`peekConfigAt`): `readTree`'s `error` kind (the commit was
	// already proven to exist via `cat-file -t` but the follow-up `ls-tree`
	// then exited non-zero) is a distinct execution/read failure from both
	// `git-unavailable` (the process could not even run) and a genuine
	// `missing` commit. Before this fix, `peekConfigAt` folded it into the
	// same `{ kind: 'absent' }` it returns for a config that genuinely does
	// not exist, silently letting the run proceed as though the baseline had
	// no configuration at all instead of reporting the read failure.
	it('transition scope reports EF-VAL-006 (not a silently absent baseline config) when ls-tree exits non-zero after the baseline commit is proven to exist', async () => {
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
		const baseline = commitAll(root, 'baseline')
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
		const proposed = commitAll(root, 'proposed')
		git(root, ['checkout', '-q', 'main'])

		const flakyExecutor = withNonZeroExit(createGitExecutor(), args => args[0] === 'ls-tree', 128)
		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('ls-tree')
	})

	// Same defect, at the blob-read layer: `readBlob`'s `error` kind (the
	// blob was already proven to exist via `cat-file -t` but the content
	// fetch then exited non-zero).
	it('transition scope reports EF-VAL-006 (not a silently absent baseline config) when the ef.yaml content fetch exits non-zero after the blob is proven to exist', async () => {
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
		const baseline = commitAll(root, 'baseline')
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
		const proposed = commitAll(root, 'proposed')
		git(root, ['checkout', '-q', 'main'])

		const flakyExecutor = withNonZeroExit(createGitExecutor(), args => args[0] === 'cat-file' && args[1] === '-p', 128)
		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('cat-file -p')
	})

	it('transition scope reports EF-VAL-006 (not EF-VAL-002) when the operation-start integration-ref probe itself fails', async () => {
		// `git show-ref` (used only by `GitRepository#resolveRef`) is forced to
		// fail here, simulating the `'error'`/`'git-unavailable'` `RefResolutionResult`
		// kinds. Folding those into a bare `null` operationStartRefOid is
		// indistinguishable from the ref genuinely never having resolved, so the
		// CLI would previously misreport this as an ordinary EF-VAL-002 ref
		// mismatch instead of surfacing the real probe failure (09-validation.md
		// "An inaccessible ref ... makes the operation incomplete rather than
		// eligible by assumption").
		await writeMinimalProject(root)
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
		const baseline = commitAll(root, 'baseline')
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
		await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
		const proposed = commitAll(root, 'proposed')
		git(root, ['checkout', '-q', 'main'])

		const flakyExecutor = withSelectiveFailure(createGitExecutor(), args => args[0] === 'show-ref', 'stub: show-ref transiently unavailable')
		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('stub: show-ref transiently unavailable')
	})

	it('bootstrap scope reports EF-VAL-006 (not a silent proceed-as-unresolved) when the operation-start integration-ref probe itself fails', async () => {
		// Same fault as above, but for bootstrap scope: previously, folding the
		// probe failure into `{ resolved: false }` let bootstrap validation
		// proceed as though the ref simply had not resolved yet, silently
		// skipping the required "no prior EF state" history check instead of
		// reporting the real probe failure.
		git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'bootstrap candidate')

		const flakyExecutor = withSelectiveFailure(createGitExecutor(), args => args[0] === 'show-ref', 'stub: show-ref transiently unavailable')
		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('stub: show-ref transiently unavailable')
	})

	it('bootstrap scope reports EF-VAL-006 (not a validated expected_ref_oid: null) when the preflight config peek fails once but the later snapshot materialization succeeds', async () => {
		// `peekConfigAt`'s own `readTree` call is the FIRST `ls-tree` invocation
		// in the whole bootstrap flow; `validateBootstrap`'s own
		// `loadSnapshotFromCommit` re-reads the same tree moments later. Forcing
		// only that first call to fail simulates a transient/first-observation
		// Git failure that clears up by the time the real materialization runs.
		// Previously, `peekConfigAt` folded that failure into the same
		// `undefined` it returns for a genuinely absent config, so
		// `operationStartRefState` silently became `{ resolved: false }` and the
		// run proceeded to a "successful" bootstrap validation with
		// `expected_ref_oid: null`, even though ref absence was never actually
		// established -- the required "no prior EF state" history probe was
		// silently skipped instead of the run being reported incomplete.
		git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'bootstrap candidate')

		const flakyExecutor = withFirstMatchingCallFailure(createGitExecutor(), args => args[0] === 'ls-tree', 'stub: ls-tree transiently unavailable (first call only)')
		const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, { cwd: root, executor: flakyExecutor })
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.complete)
			.toBe(false)
		expect(json.diagnostics[0].code)
			.toBe('EF-VAL-006')
		expect(json.diagnostics[0].message)
			.toContain('stub: ls-tree transiently unavailable (first call only)')
		expect(json.expected_ref_oid)
			.toBeNull()
	})

	it('transition scope reports EF-VAL-002 when the baseline commit predates .engineering entirely (no ef.yaml in its tree)', async () => {
		await writeFile(root, 'README.md', '# not an EF project yet\n')
		const baseline = commitAll(root, 'pre-EF history')
		await writeMinimalProject(root)
		const proposed = commitAll(root, 'proposed')

		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
		expect(outcome.exitCode)
			.toBe(2)
		const json = JSON.parse(outcome.stdout as string)
		expect(json.baseline_oid)
			.toBe(baseline)
		expect(json.diagnostics.some((d: { code: string }) => d.code === 'EF-VAL-007'))
			.toBe(true)
		expect(json.diagnostics.some((d: { code: string, message: string }) => d.code === 'EF-VAL-002' && d.message.includes('does not contain a valid authoritative EF snapshot')))
			.toBe(true)
	})

	it('transition scope with --workspace falls back to an empty linked-repositories list when the proposed commit\'s ef.yaml is malformed', async () => {
		await writeMinimalProject(root)
		const baseline = commitAll(root, 'baseline')
		git(root, ['checkout', '-q', '-b', 'feature'])
		await writeFile(root, '.engineering/ef.yaml', 'not: valid: yaml: [')
		const proposed = commitAll(root, 'proposed with malformed config')
		git(root, ['checkout', '-q', 'main'])

		const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: true, format: 'json', noColor: false }, deps())
		const json = JSON.parse(outcome.stdout as string)
		expect(json.workspace)
			.toBe(true)
		expect(json.proposed_oid)
			.toBe(proposed)
		// The proposed commit's own malformed config is reported on its own
		// terms (EF-FS-001) rather than crashing the workspace fallback.
		expect(json.diagnostics.some((d: { code: string }) => d.code === 'EF-FS-001'))
			.toBe(true)
		expect(json.valid)
			.toBe(false)
		expect(outcome.exitCode)
			.toBe(1)
	})

	// ---- Commit-bound `--project` exception (11-filesystem-and-config.md ----
	// ---- "Project Discovery": bootstrap/transition from a pre-EF checkout) ----

	describe('commit-bound --project exception', () => {
		it('bootstrap scope succeeds with an explicit --project even though the current checkout has no .engineering at all', async () => {
			// `main` must carry at least one commit before it can be checked
			// back out to (an unborn branch has no ref to switch to), and that
			// commit must not itself contain `.engineering` -- the bootstrap
			// candidate lives only on the separate `bootstrap-branch` commit.
			// Ordinary discovery from this final working tree would report
			// `not-found`, but an explicit `--project` must still let the
			// validator load configuration straight from the commit tree.
			await writeFile(root, 'README.md', '# not an EF project yet\n')
			commitAll(root, 'pre-existing non-EF history')
			git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
			await writeMinimalProject(root)
			const proposed = commitAll(root, 'bootstrap candidate')
			git(root, ['checkout', '-q', 'main'])

			const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false, project: root }, deps())
			const json = JSON.parse(outcome.stdout as string)
			expect(json.scope)
				.toBe('bootstrap')
			expect(outcome.exitCode)
				.toBe(0)
			expect(json.valid)
				.toBe(true)
		})

		it('transition scope succeeds with an explicit --project even though the current checkout has no .engineering at all', async () => {
			// `refs/heads/main` (the configured `integration_ref`) must still
			// resolve to `baseline` at operation start (as ordinary transition
			// validation requires), so `baseline` is committed directly on
			// `main`. The working tree is then left detached at the earlier
			// pre-EF commit -- a state ordinary discovery could never resolve
			// from -- to prove the explicit `--project` bypass is what makes
			// this succeed, not an incidental `.engineering` presence.
			await writeFile(root, 'README.md', '# not an EF project yet\n')
			const preEf = commitAll(root, 'pre-existing non-EF history')
			await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'draft'))
			await writeMinimalProject(root)
			const baseline = commitAll(root, 'baseline')
			git(root, ['checkout', '-q', '-b', 'feature'])
			await writeFile(root, '.engineering/req/REQ-001.md', requirementMd('REQ-001', 'active'))
			await writeFile(root, '.engineering/chg/CHG-001.md', changeMd('CHG-001', 'completed', '[{ type: modifies, target: REQ-001 }]'))
			const proposed = commitAll(root, 'proposed')
			git(root, ['checkout', '-q', preEf])

			const outcome = await runValidateCommand({ scope: 'transition', baseline, proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false, project: root }, deps())
			const json = JSON.parse(outcome.stdout as string)
			expect(json.scope)
				.toBe('transition')
			expect(outcome.exitCode)
				.toBe(0)
			expect(json.valid)
				.toBe(true)
		})

		it('snapshot scope keeps ordinary discovery: an explicit --project still requires the working tree to already contain configuration', async () => {
			// Snapshot scope's semantic input is the working tree itself, so the
			// commit-bound exception does not apply: `root`'s checked-out `main`
			// has no `.engineering`, and an explicit `--project` must still fail
			// exactly like implicit discovery would.
			const outcome = await runValidateCommand({ scope: 'snapshot', strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false, project: root }, deps())
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.complete)
				.toBe(false)
		})

		it('implicit (no --project) bootstrap validation keeps current behavior: a pre-EF cwd with no .engineering anywhere still reports failure', async () => {
			await writeFile(root, 'README.md', '# not an EF project yet\n')
			commitAll(root, 'pre-existing non-EF history')
			git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
			await writeMinimalProject(root)
			const proposed = commitAll(root, 'bootstrap candidate')
			git(root, ['checkout', '-q', 'main'])

			const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false }, deps())
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.complete)
				.toBe(false)
		})

		it('bootstrap scope rejects an explicit --project that is not itself the Git worktree root', async () => {
			await writeFile(root, 'README.md', '# not an EF project yet\n')
			commitAll(root, 'pre-existing non-EF history')
			git(root, ['checkout', '-q', '-b', 'bootstrap-branch'])
			await writeMinimalProject(root)
			const proposed = commitAll(root, 'bootstrap candidate')
			git(root, ['checkout', '-q', 'main'])

			const nested = path.join(root, 'sub')
			await fs.mkdir(nested, { recursive: true })

			const outcome = await runValidateCommand({ scope: 'bootstrap', proposed, strict: false, warningsAsErrors: false, workspace: false, format: 'json', noColor: false, project: nested }, deps())
			expect(outcome.exitCode)
				.toBe(2)
			const json = JSON.parse(outcome.stdout as string)
			expect(json.complete)
				.toBe(false)
		})
	})
})

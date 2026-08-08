/**
 * Structural checks over the Skill markdown tree that complement
 * `skill-references.unit.test.ts` (which proves every `ef ...` mention
 * matches the live CLI contract):
 *
 * 1. Reference reachability: every `references/*.md` file that ships with a
 *    Skill is reachable from that Skill's top-level `SKILL.md`, and every
 *    `references/...` path mentioned anywhere in a Skill's markdown resolves
 *    to a file that actually exists. A workflow document that no entry point
 *    links to (or a link to a deleted file) is dead weight the Agent will
 *    never load.
 * 2. Mutation examples show the plan first: in `author-engineering-files`,
 *    any documented `ef init` / `ef artifact create` invocation carrying
 *    `--yes` must be preceded, earlier in the same file, by the identical
 *    invocation carrying `--dry-run` instead — same tokens, in the same
 *    order, once `--dry-run`/`--yes` are stripped from both. Matching only on
 *    the command family (`init` vs `artifact create`) would let an unrelated
 *    earlier `--dry-run` example authorize any later `--yes` example; this
 *    pins the Skill's non-negotiable dry-run -> human confirmation -> re-run
 *    the same command with `--yes` rule structurally instead of as prose.
 * 3. Brownfield bootstrap constraints: the existing-project bootstrap
 *    reference must never demonstrate creating a CHG (bootstrap state
 *    contains no CHG by contract), must validate the working tree with
 *    snapshot scope, and must validate the exact candidate commit with
 *    bootstrap scope plus an explicit `--proposed` value.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills')

function listSkillDirectories(): string[] {
	return fs.readdirSync(skillsDir, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
}

function listMarkdownFiles(dir: string): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true })
	const files: string[] = []
	for (const entry of entries) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory())
			files.push(...listMarkdownFiles(full))
		else if (entry.isFile() && entry.name.endsWith('.md'))
			files.push(full)
	}
	return files
}

// ---- `ef ...` statement extraction, ordered by document position ----------
//
// A simplified sibling of the extractor in `skill-references.unit.test.ts`:
// it only needs fenced code blocks (every dry-run/--yes example lives in
// one), drops full-line `#` comments, starts a fresh statement at each
// literal `ef` token, and continues a statement across a trailing `\` or a
// following line whose first token is a `--flag`.

interface OrderedStatement {
	offset: number
	tokens: string[]
}

function statementsFromLines(lines: string[]): string[][] {
	const statements: string[][] = []
	let current: string[] | null = null
	let forcedContinuation = false

	for (const rawLine of lines) {
		const trimmed = rawLine.trim()
		if (trimmed.length === 0) {
			current = null
			forcedContinuation = false
			continue
		}

		const endsWithBackslash = trimmed.endsWith('\\')
		const body = endsWithBackslash
			? trimmed.slice(0, -1)
					.trim()
			: trimmed
		const tokens = body.split(/\s+/)
			.filter(Boolean)

		const isFlagContinuationLine = (tokens[0] ?? '').startsWith('--')
		if (!forcedContinuation && !isFlagContinuationLine)
			current = null

		for (const token of tokens) {
			if (token === 'ef') {
				current = [token]
				statements.push(current)
				continue
			}
			current?.push(token)
		}

		forcedContinuation = endsWithBackslash && current !== null
	}

	return statements
}

function extractStatements(text: string): OrderedStatement[] {
	const statements: OrderedStatement[] = []
	const fencedBlockPattern = /```[^\n]*\n([\s\S]*?)```/g
	for (const match of text.matchAll(fencedBlockPattern)) {
		const lines = match[1]!.split('\n')
			.filter(line => !line.trim()
				.startsWith('#'))
		for (const statement of statementsFromLines(lines))
			statements.push({ offset: match.index!, tokens: statement })
	}
	return statements
}

// ---- Tests ------------------------------------------------------------------

const skillNames = listSkillDirectories()

describe('every shipped reference is reachable and every referenced path exists', () => {
	it.each(skillNames)('%s', (skillName) => {
		const skillDir = path.join(skillsDir, skillName)
		const skillFile = path.join(skillDir, 'SKILL.md')
		expect(fs.existsSync(skillFile), `expected ${skillFile}`)
			.toBe(true)
		const skillText = fs.readFileSync(skillFile, 'utf8')

		const referencesDir = path.join(skillDir, 'references')
		const shippedReferences = fs.existsSync(referencesDir)
			? listMarkdownFiles(referencesDir)
					.map(file => path.relative(skillDir, file)
						.split(path.sep)
						.join('/'))
			: []

		for (const reference of shippedReferences) {
			expect(skillText.includes(reference), `${skillName}/SKILL.md never mentions shipped reference ${reference}`)
				.toBe(true)
		}

		for (const file of listMarkdownFiles(skillDir)) {
			const text = fs.readFileSync(file, 'utf8')
			for (const match of text.matchAll(/references\/[\w./-]+\.md/g)) {
				const target = path.join(skillDir, match[0])
				expect(fs.existsSync(target), `${path.relative(skillsDir, file)} references missing file ${match[0]}`)
					.toBe(true)
			}
		}
	})
})

/** `init` or `artifact create` — the two mutation commands that take `--yes`. */
function isMutationStatement(tokens: string[]): boolean {
	return tokens[1] === 'init' || (tokens[1] === 'artifact' && tokens[2] === 'create')
}

/** A statement's authorization identity: every token except `--dry-run` and `--yes`, in order. */
function normalizedInvocationKey(tokens: string[]): string {
	return tokens.filter(token => token !== '--dry-run' && token !== '--yes')
		.join(' ')
}

/**
 * Given mutation statements in document order, returns the token lists of every
 * `--yes` statement that lacks an earlier, identically-normalized `--dry-run`
 * statement. Exported so the pairing rule itself — not just its effect on the
 * shipped references — has a direct, synthetic test.
 */
export function findUnauthorizedYesStatements(statements: string[][]): string[][] {
	const seenDryRunKeys = new Set<string>()
	const violations: string[][] = []

	for (const tokens of statements) {
		if (!isMutationStatement(tokens))
			continue
		const key = normalizedInvocationKey(tokens)
		if (tokens.includes('--dry-run')) {
			seenDryRunKeys.add(key)
			continue
		}
		if (tokens.includes('--yes') && !seenDryRunKeys.has(key))
			violations.push(tokens)
	}

	return violations
}

describe('author-engineering-files mutation examples plan before applying', () => {
	const authoringDir = path.join(skillsDir, 'author-engineering-files')
	const markdownFiles = listMarkdownFiles(authoringDir)

	it.each(markdownFiles.map(file => path.relative(authoringDir, file)))('%s', (relativeFile) => {
		const text = fs.readFileSync(path.join(authoringDir, relativeFile), 'utf8')
		const statements = extractStatements(text)
			.map(statement => statement.tokens)
		const violations = findUnauthorizedYesStatements(statements)
		expect(
			violations,
			`${relativeFile}: found '--yes' example(s) with no preceding identical '--dry-run' plan: ${JSON.stringify(violations)}`,
		)
			.toEqual([])
	})

	it('pairs on the full normalized invocation, not just the command family', () => {
		const dryRun = ['ef', 'init', '--title', '"<text>"', '--dry-run']
		const identicalYes = ['ef', 'init', '--title', '"<text>"', '--yes']
		const differentYes = ['ef', 'init', '--title', '"<other>"', '--yes']

		expect(findUnauthorizedYesStatements([dryRun, identicalYes]))
			.toEqual([])
		expect(findUnauthorizedYesStatements([dryRun, differentYes]))
			.toEqual([differentYes])
		expect(findUnauthorizedYesStatements([identicalYes, dryRun]))
			.toEqual([identicalYes])
	})

	it('exercises at least one dry-run/--yes pair (guards the extractor itself)', () => {
		const pairedFiles = markdownFiles.filter((file) => {
			const statements = extractStatements(fs.readFileSync(file, 'utf8'))
			return statements.some(s => s.tokens.includes('--dry-run'))
				&& statements.some(s => s.tokens.includes('--yes'))
		})
		expect(pairedFiles.length)
			.toBeGreaterThan(0)
	})
})

describe('existing-project bootstrap reference honors the bootstrap contract', () => {
	const bootstrapFile = path.join(skillsDir, 'author-engineering-files/references/existing-project-bootstrap.md')
	const text = fs.readFileSync(bootstrapFile, 'utf8')
	const statements = extractStatements(text)

	it('never demonstrates creating a CHG (bootstrap contains no CHG)', () => {
		const chgCreations = statements.filter(s => s.tokens[1] === 'artifact' && s.tokens[2] === 'create' && s.tokens[3] === 'chg')
		expect(chgCreations)
			.toEqual([])
	})

	it('validates the working tree with snapshot scope', () => {
		const snapshotValidations = statements.filter(s =>
			s.tokens[1] === 'validate'
			&& s.tokens[s.tokens.indexOf('--scope') + 1] === 'snapshot')
		expect(snapshotValidations.length)
			.toBeGreaterThan(0)
	})

	it('validates the exact candidate commit with bootstrap scope and an explicit --proposed', () => {
		const bootstrapValidations = statements.filter(s =>
			s.tokens[1] === 'validate'
			&& s.tokens[s.tokens.indexOf('--scope') + 1] === 'bootstrap'
			&& s.tokens.includes('--proposed'))
		expect(bootstrapValidations.length)
			.toBeGreaterThan(0)
	})
})

/**
 * 00-implementation-decisions.md: "Tests or static checks must verify that
 * commands and flags referenced by Skills exist in the matching CLI version."
 *
 * This scans every `.md` file under `skills/` for `ef ...` invocations --
 * inside fenced code blocks and inline code spans -- and checks every parsed
 * command path and `--flag` against the *actual* Commander program built by
 * `buildProgram` (src/cli/program.ts), never a hand-maintained mirror of it.
 * If a Skill author invents a command or flag that does not exist in the
 * real CLI, this test fails.
 *
 * Parsing approach: within one fenced block or one inline code span, full
 * comment-only lines (`#...`) are dropped first. Remaining lines are read one
 * at a time, tracking an "open" statement: a literal `ef` token anywhere on a
 * line always starts a fresh statement (discarding any prose lead-in on that
 * same line, e.g. "-> references/project-init.md (ef init)"); a line whose
 * first token is a bare `--flag` continues the currently open statement even
 * with no trailing `\` (the "Command shape" block in `validation-recipes.md`
 * lists its flags one per indented line with no backslashes); a trailing `\`
 * always continues the statement onto the next line regardless of what that
 * line starts with (ordinary `bash` line continuation); any other line closes
 * the currently open statement before it is processed. This means two
 * sequential one-line invocations in the same fenced block, and a one-line
 * aside mentioning `ef init` inside otherwise unrelated prose, are each read
 * as independent, correctly-bounded statements.
 *
 * Each statement's leading words are then walked down the live command tree.
 * A bracket/angle-bracket placeholder (`<id>`, `*`, `...`, an `a|b` choice
 * list) stops path-descent without failing, since it marks a value slot or a
 * deliberately generic mention (for example "every `ef ... --format json`
 * result") rather than an invented command segment. Once a leaf command (one
 * with no further subcommands) is reached, every following non-flag token is
 * treated as a positional argument value (an example ID, a type token, a
 * path) rather than an invented subcommand -- Skills illustrate real IDs like
 * `REQ-031` in place of `<artifact-id>` and that is not itself an error.
 * Every remaining `--flag` token is checked against the options of whichever
 * command node was last matched; if no real command segment was ever matched
 * (the statement is generic from its very first token), flags are not
 * checked at all -- there is no specific command to check them against.
 */

import type { Command } from 'commander'
import type { GitExecutor } from '../git/executor'
import type { Prompts } from './prompts'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildProgram } from './program'

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills')

// ---- Build the real command tree (no parsing, no action ever runs) --------

interface CliNode {
	options: Set<string>
	children: Map<string, CliNode>
}

function neverExecutor(): GitExecutor {
	return {
		exec: async () => { throw new Error('skill-references test must never execute a command') },
		execIn: async () => { throw new Error('skill-references test must never execute a command') },
	}
}

function neverPrompts(): Prompts {
	return {
		intro: () => {},
		outro: () => {},
		note: () => {},
		text: async () => { throw new Error('skill-references test must never prompt') },
		confirm: async () => { throw new Error('skill-references test must never prompt') },
		confirmMutation: async () => { throw new Error('skill-references test must never prompt') },
	}
}

function buildNode(command: Command): CliNode {
	const options = new Set<string>()
	for (const option of command.options) {
		if (option.long)
			options.add(option.long)
		if (option.short)
			options.add(option.short)
	}
	const children = new Map<string, CliNode>()
	for (const child of command.commands)
		children.set(child.name(), buildNode(child))
	return { options, children }
}

function buildCommandTree(): Map<string, CliNode> {
	const program = buildProgram(
		{ cwd: process.cwd() },
		{ version: '0.0.0-test' },
		neverExecutor(),
		neverPrompts(),
		() => {},
	)
	const root = new Map<string, CliNode>()
	for (const child of program.commands)
		root.set(child.name(), buildNode(child))
	return root
}

// ---- Markdown scanning ------------------------------------------------------

interface RawInvocation {
	file: string
	line: number
	statement: string[]
}

/** Strip a leading/trailing wrapper (brackets, punctuation, quotes) a token may carry from surrounding prose or shell syntax, e.g. `(ef` -> `ef`, `init)` -> `init`, `"<text>"` -> `<text>`. */
function unwrap(token: string): string {
	let value = token
	while (value.length > 0 && '([{"\''.includes(value[0]!))
		value = value.slice(1)
	while (value.length > 0 && ')]}.,;:"\''.includes(value[value.length - 1]!))
		value = value.slice(0, -1)
	return value
}

/** A value slot or deliberately generic marker: never a real command/subcommand name. */
function isPlaceholder(token: string): boolean {
	return token === '*' || token === '...' || /^<[^<>]*>$/.test(token) || token.includes('|')
}

function isFlag(token: string): boolean {
	return token.startsWith('--')
}

/** See the module doc comment for the continuation rules this implements. */
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
			.map(unwrap)
			.filter(token => token.length > 0)

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

/** Drop full-line `#` comments before building statements from a block's lines. */
function codeLines(content: string): string[] {
	return content.split('\n')
		.filter(line => !line.trim()
			.startsWith('#'))
}

function lineNumberAt(text: string, index: number): number {
	let line = 1
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === '\n')
			line++
	}
	return line
}

function extractInvocations(file: string, text: string): RawInvocation[] {
	const invocations: RawInvocation[] = []
	const fencedBlockPattern = /```[^\n]*\n([\s\S]*?)```/g
	const fencedRanges: Array<[number, number]> = []

	for (const match of text.matchAll(fencedBlockPattern)) {
		const start = match.index!
		const end = start + match[0].length
		fencedRanges.push([start, end])
		const line = lineNumberAt(text, start)
		for (const statement of statementsFromLines(codeLines(match[1]!)))
			invocations.push({ file, line, statement })
	}

	const inlineCodePattern = /`([^`\n]+)`/g
	for (const match of text.matchAll(inlineCodePattern)) {
		const start = match.index!
		if (fencedRanges.some(([rangeStart, rangeEnd]) => start >= rangeStart && start < rangeEnd))
			continue
		const line = lineNumberAt(text, start)
		for (const statement of statementsFromLines(codeLines(match[1]!)))
			invocations.push({ file, line, statement })
	}

	return invocations
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

// ---- Statement validation against the real command tree -------------------

function checkStatement(root: Map<string, CliNode>, statement: string[]): string[] {
	const errors: string[] = []
	let children = root
	let matchedNode: CliNode | undefined
	const matchedPath: string[] = []
	let i = 1 // statement[0] is always the literal 'ef' token

	for (; i < statement.length; i++) {
		const token = statement[i]!
		if (isFlag(token) || isPlaceholder(token))
			break
		if (children.size === 0) {
			// Already at a leaf command: this token is a positional argument
			// value (an example ID, a type token, a path), not a subcommand.
			continue
		}
		const next = children.get(token)
		if (!next) {
			errors.push(`unknown command segment '${token}' in 'ef ${[...matchedPath, token].join(' ')}'`)
			return errors
		}
		matchedNode = next
		children = next.children
		matchedPath.push(token)
	}

	// No real command segment was ever matched: the statement is a generic
	// mention (e.g. "ef ... --format json") with nothing specific to check
	// flags against.
	if (!matchedNode)
		return errors

	for (; i < statement.length; i++) {
		const token = statement[i]!
		if (!isFlag(token))
			continue
		const flagName = token.split('=')[0]!
		if (!matchedNode.options.has(flagName))
			errors.push(`unknown flag '${flagName}' for 'ef ${matchedPath.join(' ')}'`)
	}

	return errors
}

// ---- Tests ------------------------------------------------------------------

describe('skill references match the ef CLI contract', () => {
	it('finds the skills directory to scan', () => {
		expect(fs.existsSync(skillsDir), `expected a skills directory at ${skillsDir}`)
			.toBe(true)
		expect(fs.statSync(skillsDir)
			.isDirectory(), `${skillsDir} exists but is not a directory`)
			.toBe(true)
	})

	const markdownFiles = fs.existsSync(skillsDir) ? listMarkdownFiles(skillsDir) : []

	it('scans at least one Skill markdown file', () => {
		expect(markdownFiles.length)
			.toBeGreaterThan(0)
	})

	const root = buildCommandTree()

	it('the built command tree exposes every documented top-level command', () => {
		for (const name of ['init', 'artifact', 'validate', 'query', 'resource', 'version', 'help']) {
			expect(root.has(name), `expected a top-level '${name}' command`)
				.toBe(true)
		}
	})

	const allInvocations = markdownFiles.flatMap(file => extractInvocations(path.relative(skillsDir, file), fs.readFileSync(file, 'utf8')))

	it('extracts at least one `ef ...` invocation from the Skills', () => {
		expect(allInvocations.length)
			.toBeGreaterThan(0)
	})

	it('every `ef ...` command path and flag referenced by a Skill exists in the CLI contract', () => {
		const failures: string[] = []
		for (const invocation of allInvocations) {
			for (const error of checkStatement(root, invocation.statement))
				failures.push(`${invocation.file}:${invocation.line}: ${error}`)
		}
		expect(failures, failures.join('\n'))
			.toEqual([])
	})
})

/**
 * Commander wiring and top-level dispatch (13-cli-contract.md "Command
 * Surface", "Common Options", "JSON Transport").
 *
 * Every command registers only the options that apply to it -- there is no
 * shared/inherited option set -- so Commander's own "unknown option" error
 * enforces 13-cli-contract.md's "Options that do not apply to a command are
 * invalid invocation rather than silently ignored" without a separate
 * allow-list check. `--format`'s value and `validate`'s `--scope` value are
 * validated through Commander's `Option#choices`, which also throws on an
 * invalid value.
 *
 * Every error Commander itself throws (`exitOverride()` makes every internal
 * exit path throw a `CommanderError` instead of calling `process.exit`) is
 * necessarily a "syntax failure that prevents selecting an envelope" --
 * unknown command/subcommand, unknown option, wrong argument count, or an
 * invalid `--format`/`--scope` value -- because every option whose
 * content* validity depends on other options (`--baseline`/`--proposed`
 * required-ness, filter values, numeric ranges) is deliberately left
 * syntactically optional at the Commander level and validated inside the
 * command handler instead, where a failure naturally produces the
 * documented incomplete envelope. This is what makes "catch every
 * `CommanderError` as pre-envelope failure" correct without needing to track
 * parse order explicitly. The one deliberate exception is `-h`/`--help`
 * (13-cli-contract.md "Version and Help"): Commander's `exitOverride()` also
 * turns its internal help-display `_exit(0, ...)` into a thrown
 * `CommanderError`, but `attachHelp` below already reported that outcome as
 * a pre-envelope success via `setOutcome` before the throw, and `runCli`
 * recognizes that case to return the success instead of a syntax failure.
 */

import type { GitExecutor } from '../git/executor'
import type { CommandOutcome } from './command-outcome'
import type { Prompts } from './prompts'
import process from 'node:process'
import { Command, CommanderError, Option } from 'commander'
import { runArtifactCreateCommand } from './commands/artifact-create'
import { runInitCommand } from './commands/init'
import { runQueryCommand } from './commands/query'
import {
	buildHistoryRequest,
	buildImpactRequest,
	buildListRequest,
	buildLookupRequest,
	buildRelationsRequest,
	buildResolveCurrentRequest,
	buildSearchRequest,
	buildTraceRequest,
} from './commands/query-request-builders'
import { runResourceReadCommand } from './commands/resource-read'
import { runValidateCommand } from './commands/validate'
import { runVersionCommand } from './commands/version'
import { createDefaultGitExecutor } from './project-context'
import { createRealPrompts } from './prompts'

export interface CliIO {
	cwd: string
}

export interface RunCliContext {
	version: string
	executor?: GitExecutor
	prompts?: Prompts
}

function preEnvelopeFailure(message: string): CommandOutcome {
	return { exitCode: 2, stdout: '', stderr: `${message}\n` }
}

function internalFailure(message: string): CommandOutcome {
	return { exitCode: 3, stdout: '', stderr: `${message}\n` }
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value]
}

function boolOpt(value: unknown): boolean {
	return value === true
}

function FORMAT_OPTION() {
	return new Option('--format <format>', 'output format')
		.choices(['human', 'json'])
		.default('human')
}

const HELP_TOPICS: Record<string, string> = {
	'init': 'ef init: initialize EF in an existing Git worktree root.',
	'artifact create': 'ef artifact create <type>: create a new draft Artifact (prd|req|adr|pol|chg).',
	'validate': 'ef validate [--scope snapshot|transition|bootstrap|range]: validate the EF project state.',
	'query': 'ef query <lookup|list|search|relations|trace|impact|history|resolve-current>: read-only queries.',
	'resource read': 'ef resource read <owner-id> <location>: read one explicitly selected local Resource.',
	'version': 'ef version: print the implementation version.',
	'help': 'ef help [command]: show this help, or help for one command.',
}

const GENERAL_HELP = [
	'ef -- a thin CLI over Git-native EF files.',
	'',
	'Commands:',
	'  ef init',
	'  ef artifact create <type>',
	'  ef validate',
	'  ef query <lookup|list|search|relations|trace|impact|history|resolve-current>',
	'  ef resource read <owner-id> <location>',
	'  ef version',
	'  ef help',
	'',
	'Every command and subcommand also accepts -h / --help.',
].join('\n')

/**
 * The full command path leading to `command` (e.g. `['artifact', 'create']`
 * for `ef artifact create <type>`), excluding the root `ef` program itself
 * (13-cli-contract.md "Version and Help").
 */
function commandPathWords(command: Command): string[] {
	const words: string[] = []
	let current: Command | null = command
	while (current && current.parent) {
		words.unshift(current.name())
		current = current.parent
	}
	return words
}

/**
 * Resolves `-h`/`--help` text for an already-recognized command path: the
 * exact `HELP_TOPICS` entry for the full path, then each shorter prefix,
 * then `GENERAL_HELP`. Unlike the explicit `ef help <command>` lookup below
 * (which fails with an unknown-topic invocation error), this always
 * succeeds because it is only ever reached for a command Commander itself
 * already resolved.
 */
function resolveHelpTopicWithFallback(words: readonly string[]): string {
	for (let end = words.length; end >= 1; end--) {
		const prefix = words
			.slice(0, end)
			.join(' ')
		const text = HELP_TOPICS[prefix]
		if (text)
			return text
	}
	return GENERAL_HELP
}

/**
 * Enables `-h`/`--help` on `command` and routes its output through
 * `setOutcome` as a pre-envelope success (13-cli-contract.md "Version and
 * Help"), instead of through Commander's own (deliberately no-op) output
 * writers or exit path. Text is always the fixed human help for this
 * command's path, regardless of `--format` or any other option already
 * supplied -- help wins and is never wrapped in a JSON envelope.
 *
 * Commander also calls `outputHelp` with `{ error: true }` for its own
 * "invalid invocation, show help" fallback (an unmatched group command, or a
 * bare `ef` with no recognized subcommand) -- that path is a genuine
 * pre-envelope invocation failure, not a `-h`/`--help` request, so it is left
 * alone here (no `setOutcome` call) and allowed to keep throwing through to
 * `runCli`'s ordinary `CommanderError` handling.
 */
function attachHelp(command: Command, setOutcome: (outcome: CommandOutcome) => void): Command {
	command.helpOption('-h, --help', 'display help for this command')
	command.outputHelp = (context?: { error: boolean } | ((str: string) => string)) => {
		if (context && typeof context !== 'function' && context.error)
			return
		setOutcome({ exitCode: 0, stdout: `${resolveHelpTopicWithFallback(commandPathWords(command))}\n`, stderr: '' })
	}
	return command
}

/**
 * Build the full `ef` Commander program without parsing or executing
 * anything. This is the single source of truth for the command surface
 * (subcommand names and their `Option`s): `runCli` below parses `argv`
 * against the program this returns, and `skill-references.unit.test.ts`
 * introspects `program.commands` / `command.options` from this same
 * builder to check every `ef ...` invocation documented in `skills/` against
 * the real, live command definitions -- never a hand-maintained string list.
 *
 * `executor`, `prompts`, and `context.version` are only reached once an
 * action actually runs, so a caller that only wants to introspect
 * commands/options (never calling `parseAsync`) may pass placeholder values.
 */
export function buildProgram(io: CliIO, context: RunCliContext, executor: GitExecutor, prompts: Prompts, setOutcome: (outcome: CommandOutcome) => void): Command {
	const program = new Command('ef')
	program.exitOverride()
	program.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })
	attachHelp(program, setOutcome)
	program.addHelpCommand(false)

	/**
	 * Applies the standard non-inherited-option-set wiring (exitOverride,
	 * no-op output, `-h`/`--help`) to a freshly created command. Every
	 * subcommand and leaf command in this file goes through this so `-h`/
	 * `--help` behaves identically everywhere (13-cli-contract.md "Version
	 * and Help").
	 */
	function applyCommandDefaults(command: Command): Command {
		command.exitOverride()
		command.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })
		attachHelp(command, setOutcome)
		return command
	}

	function sub(name: string, argsUsage = ''): Command {
		return applyCommandDefaults(program.command(`${name}${argsUsage ? ` ${argsUsage}` : ''}`))
	}

	// ---- ef init ----------------------------------------------------------------

	sub('init')
		.addOption(new Option('--project <project-root>'))
		.addOption(FORMAT_OPTION())
		.option('--no-color')
		.option('--no-input')
		.option('--dry-run')
		.option('--yes')
		.option('--title <text>')
		.option('--summary <text>')
		.option('--vision <markdown>')
		.option('--project-scope <markdown>')
		.option('--non-goals <markdown>')
		.option('--context <markdown>')
		.option('--integration-ref <ref>')
		.option('--terminology <markdown-table>')
		.action(async (opts) => {
			const format = opts.format as 'human' | 'json'
			const noInput = !opts.input || format === 'json'
			setOutcome(await runInitCommand({
				project: opts.project,
				format,
				noColor: !opts.color,
				noInput,
				dryRun: boolOpt(opts.dryRun),
				yes: boolOpt(opts.yes),
				values: {
					title: opts.title,
					summary: opts.summary,
					vision: opts.vision,
					projectScope: opts.projectScope,
					nonGoals: opts.nonGoals,
					context: opts.context,
					integrationRef: opts.integrationRef,
					terminology: opts.terminology,
				},
			}, { cwd: io.cwd, executor, prompts }))
		})

	// ---- ef artifact create <type> -----------------------------------------------

	const artifact = sub('artifact')
	applyCommandDefaults(artifact.command('create <type>'))
		.addOption(new Option('--project <project-root>'))
		.addOption(FORMAT_OPTION())
		.option('--no-color')
		.option('--no-input')
		.option('--dry-run')
		.option('--yes')
		.option('--title <text>')
		.option('--summary <text>')
		.action(async (type: string, opts) => {
			const format = opts.format as 'human' | 'json'
			const noInput = !opts.input || format === 'json'
			setOutcome(await runArtifactCreateCommand({
				type,
				title: opts.title,
				summary: opts.summary,
				project: opts.project,
				format,
				noColor: !opts.color,
				noInput,
				dryRun: boolOpt(opts.dryRun),
				yes: boolOpt(opts.yes),
			}, { cwd: io.cwd, executor, prompts }))
		})

	// ---- ef validate --------------------------------------------------------------

	sub('validate')
		.addOption(new Option('--project <project-root>'))
		.addOption(FORMAT_OPTION())
		.option('--no-color')
		.option('--no-input')
		.addOption(new Option('--scope <scope>')
			.choices(['snapshot', 'transition', 'bootstrap', 'range'])
			.default('snapshot'))
		.option('--baseline <oid>')
		.option('--proposed <oid>')
		.option('--strict')
		.option('--warnings-as-errors')
		.option('--workspace')
		.action(async (opts) => {
			setOutcome(await runValidateCommand({
				scope: opts.scope,
				baseline: opts.baseline,
				proposed: opts.proposed,
				strict: boolOpt(opts.strict),
				warningsAsErrors: boolOpt(opts.warningsAsErrors),
				workspace: boolOpt(opts.workspace),
				format: opts.format,
				noColor: !opts.color,
				project: opts.project,
			}, { cwd: io.cwd, executor }))
		})

	// ---- ef query <kind> ----------------------------------------------------------

	const query = sub('query')

	function queryCommonOptions(command: Command): Command {
		return command
			.addOption(new Option('--project <project-root>'))
			.addOption(FORMAT_OPTION())
			.option('--no-color')
			.option('--no-input')
	}

	function queryLeaf(name: string, argsUsage: string): Command {
		const command = applyCommandDefaults(query.command(`${name}${argsUsage ? ` ${argsUsage}` : ''}`))
		return queryCommonOptions(command)
	}

	function runQuery(request: Parameters<typeof runQueryCommand>[0], opts: Record<string, unknown>): Promise<CommandOutcome> {
		return runQueryCommand(request, { project: opts.project as string | undefined, format: opts.format as 'human' | 'json', noColor: !opts.color }, { cwd: io.cwd, executor })
	}

	queryLeaf('lookup', '[artifact-id]')
		.option('--projection <projection>')
		.action(async (artifactId: string | undefined, opts) => {
			setOutcome(await runQuery(buildLookupRequest({ id: artifactId, projection: opts.projection }), opts))
		})

	queryLeaf('list', '')
		.option('--type <value>', '', collect, [])
		.option('--status <value>', '', collect, [])
		.option('--schema <value>')
		.option('--tag-any <value>', '', collect, [])
		.option('--tag-all <value>', '', collect, [])
		.option('--relation-type <value>')
		.option('--relation-target <artifact-id>')
		.option('--resource-type <value>')
		.option('--resource-role <value>')
		.option('--resource-normative <boolean>')
		.option('--offset <n>')
		.option('--limit <n>')
		.action(async (opts) => {
			const built = buildListRequest({
				type: opts.type,
				status: opts.status,
				schema: opts.schema,
				tagAny: opts.tagAny,
				tagAll: opts.tagAll,
				relationType: opts.relationType,
				relationTarget: opts.relationTarget,
				resourceType: opts.resourceType,
				resourceRole: opts.resourceRole,
				resourceNormative: opts.resourceNormative,
				offset: opts.offset,
				limit: opts.limit,
			})
			if (!built.ok) {
				const format = opts.format as 'human' | 'json'
				const json = { ...built.result, diagnostics: built.result.diagnostics }
				setOutcome(format === 'json'
					? { exitCode: 2, stdout: `${JSON.stringify(json)}\n`, stderr: '' }
					: { exitCode: 2, stdout: `${JSON.stringify(json, null, 2)}\n`, stderr: '' })
				return
			}
			setOutcome(await runQuery(built.request, opts))
		})

	queryLeaf('search', '[term...]')
		.option('--case-sensitive')
		.option('--offset <n>')
		.option('--limit <n>')
		.action(async (terms: string[], opts) => {
			setOutcome(await runQuery(buildSearchRequest({ terms, caseSensitive: boolOpt(opts.caseSensitive), offset: opts.offset, limit: opts.limit }), opts))
		})

	queryLeaf('relations', '[artifact-id]')
		.option('--direction <direction>')
		.option('--type <relation-type>', '', collect, [])
		.action(async (artifactId: string | undefined, opts) => {
			setOutcome(await runQuery(buildRelationsRequest({ id: artifactId, direction: opts.direction, types: opts.type }), opts))
		})

	queryLeaf('trace', '[root-id...]')
		.option('--type <relation-type>', '', collect, [])
		.option('--direction <direction>')
		.option('--max-depth <n>')
		.action(async (roots: string[], opts) => {
			setOutcome(await runQuery(buildTraceRequest({ roots, types: opts.type, direction: opts.direction, maxDepth: opts.maxDepth }), opts))
		})

	queryLeaf('impact', '[root-id...]')
		.option('--max-depth <n>')
		.option('--include-references')
		.option('--include-non-current')
		.option('--resolve-current')
		.action(async (roots: string[], opts) => {
			setOutcome(await runQuery(buildImpactRequest({
				roots,
				maxDepth: opts.maxDepth,
				includeReferences: boolOpt(opts.includeReferences),
				includeNonCurrent: boolOpt(opts.includeNonCurrent),
				resolveCurrent: boolOpt(opts.resolveCurrent),
			}), opts))
		})

	queryLeaf('history', '[artifact-id]')
		.action(async (artifactId: string | undefined, opts) => {
			setOutcome(await runQuery(buildHistoryRequest({ id: artifactId }), opts))
		})

	queryLeaf('resolve-current', '[artifact-id]')
		.action(async (artifactId: string | undefined, opts) => {
			setOutcome(await runQuery(buildResolveCurrentRequest({ id: artifactId }), opts))
		})

	// ---- ef resource read <owner-id> <location> ------------------------------------

	const resource = sub('resource')
	applyCommandDefaults(resource.command('read <owner-id> <location>'))
		.addOption(new Option('--project <project-root>'))
		.option('--no-color')
		.option('--no-input')
		.action(async (ownerId: string, location: string, opts) => {
			setOutcome(await runResourceReadCommand(ownerId, location, { project: opts.project }, { cwd: io.cwd, executor }))
		})

	// ---- ef version ---------------------------------------------------------------

	sub('version')
		.addOption(FORMAT_OPTION())
		.action(async (opts) => {
			setOutcome(runVersionCommand({ format: opts.format, version: context.version }))
		})

	// ---- ef help [command] ---------------------------------------------------------

	sub('help', '[command...]')
		.action(async (commandWords: string[]) => {
			if (commandWords.length === 0) {
				setOutcome({ exitCode: 0, stdout: `${GENERAL_HELP}\n`, stderr: '' })
				return
			}
			const topic = commandWords.join(' ')
			const text = HELP_TOPICS[topic]
			setOutcome(text
				? { exitCode: 0, stdout: `${text}\n`, stderr: '' }
				: preEnvelopeFailure(`Unknown help topic: '${topic}'.`))
		})

	return program
}

export async function runCli(argv: readonly string[], io: CliIO, context: RunCliContext): Promise<CommandOutcome> {
	const executor = context.executor ?? createDefaultGitExecutor()
	const prompts = context.prompts ?? createRealPrompts(chunk => process.stderr.write(chunk))

	let outcome: CommandOutcome | undefined
	const program = buildProgram(io, context, executor, prompts, (result) => {
		outcome = result
	})

	try {
		await program.parseAsync(argv as string[], { from: 'user' })
	}
	catch (error) {
		if (error instanceof CommanderError) {
			// `-h`/`--help` (via `attachHelp`'s `outputHelp` override above) already
			// called `setOutcome` with the pre-envelope success before Commander's
			// `exitOverride()` turned its own internal `_exit(0, ...)` into this
			// thrown `CommanderError` -- return that captured outcome instead of
			// treating a successful help display as an invocation failure. The
			// `outcome` check excludes Commander's *other* use of the same error
			// codes (`this.help({ error: true })` for its "invalid invocation, show
			// help" fallback), which `attachHelp` deliberately leaves for the
			// `preEnvelopeFailure` branch below because `outputHelp` skips
			// `setOutcome` in that case.
			if ((error.code === 'commander.help' || error.code === 'commander.helpDisplayed') && outcome)
				return outcome
			return preEnvelopeFailure(error.message || 'Invalid invocation.')
		}
		return internalFailure(`Internal CLI failure: ${(error as Error).message}`)
	}

	return outcome ?? preEnvelopeFailure('No command was recognized.')
}

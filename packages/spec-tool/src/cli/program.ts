import type { CommandOutcome } from './command-outcome'
import { Command, CommanderError, Option } from 'commander'
import { diagnostic } from '../domain/diagnostics'
import { runArtifactCreateCommand, runArtifactDeleteCommand, runArtifactGetCommand, runArtifactListCommand, runArtifactUpdateCommand } from './commands/artifact'
import { runInitCommand } from './commands/init'
import { runLifecycleActivateCommand, runLifecycleCompleteCommand, runLifecycleRetireCommand, runLifecycleSupersedeCommand } from './commands/lifecycle'
import { runSearchCommand, runTraceCommand } from './commands/query'
import { runRelationAddCommand, runRelationListCommand, runRelationRemoveCommand } from './commands/relation'
import { runResourceAddCommand, runResourceListCommand, runResourceReadCommand, runResourceRemoveCommand } from './commands/resource'
import { runValidateCommand } from './commands/validate'
import { runVersionCommand } from './commands/version'
import { errorResultJson } from './envelopes'

export interface CliIO {
	cwd: string
}

export interface RunCliContext {
	version: string
}

const GENERAL_HELP = [
	'Spec — Git-native engineering specification maintenance tool.',
	'',
	'Commands:',
	'  spec init',
	'  spec artifact <create|get|update|delete|list>',
	'  spec relation <add|remove|list>',
	'  spec lifecycle <activate|complete|retire|supersede>',
	'  spec resource <add|remove|list|read>',
	'  spec search <text>',
	'  spec trace <artifact-id>',
	'  spec validate',
	'  spec version',
	'',
	'Use "spec <command> --help" for command-specific options.',
].join('\n')

function formatOption(): Option {
	return new Option('--format <format>', 'output format')
		.choices(['human', 'json'])
		.default('human')
}

function asBoolean(value: unknown): boolean {
	return value === true
}

export function buildProgram(io: CliIO, context: RunCliContext, setOutcome: (outcome: CommandOutcome) => void): Command {
	const program = new Command('spec')
	program.description('Git-native engineering specification maintenance tool.')
	program.exitOverride()
	program.configureOutput({
		writeOut: text => setOutcome({ exitCode: 0, stdout: text, stderr: '' }),
		writeErr: text => setOutcome({ exitCode: 2, stdout: '', stderr: text }),
		outputError: (text, write) => write(text),
	})
	program.helpOption('-h, --help', 'display help for command')
	program.addHelpCommand()

	program.command('init')
		.description('Initialize a complete .spec/ workspace and PROJECT Artifact.')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the current directory'))
		.addOption(formatOption())
		.option('--no-color')
		.option('--no-input')
		.option('--title <text>')
		.option('--vision <markdown>')
		.option('--scope <markdown>')
		.option('--non-goals <markdown>')
		.option('--context <markdown>')
		.option('--terminology <markdown>')
		.action(async (options: Record<string, unknown>) => {
			const format = options.format as 'human' | 'json'
			setOutcome(await runInitCommand({
				project: options.project as string | undefined,
				format,
				noInput: !options.input || format === 'json',
				noColor: !asBoolean(options.color),
				values: {
					title: options.title as string | undefined,
					vision: options.vision as string | undefined,
					scope: options.scope as string | undefined,
					nonGoals: options.nonGoals as string | undefined,
					context: options.context as string | undefined,
					terminology: options.terminology as string | undefined,
				},
			}, { cwd: io.cwd }))
		})

	program.command('search')
		.description('Search Artifact title/body text in the current workspace.')
		.argument('<text>')
		.option('--kind <kind>')
		.option('--status <status>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (text: string, options: Record<string, unknown>) => {
			setOutcome(await runSearchCommand(text, options, { cwd: io.cwd }))
		})

	program.command('trace')
		.description('Trace the refines chain around an Artifact.')
		.argument('<artifact-id>')
		.option('--direction <direction>', 'up, down, or both', 'both')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (artifactId: string, options: Record<string, unknown>) => {
			setOutcome(await runTraceCommand(artifactId, options, { cwd: io.cwd }))
		})

	program.command('validate')
		.description('Validate the current .spec/ workspace.')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.option('--no-input')
		.action(async (options: Record<string, unknown>) => {
			setOutcome(await runValidateCommand({
				project: options.project as string | undefined,
				format: options.format as 'human' | 'json',
				noColor: !asBoolean(options.color),
			}, { cwd: io.cwd }))
		})

	program.command('version')
		.description('Print the Spec CLI version.')
		.addOption(formatOption())
		.action((options: Record<string, unknown>) => {
			setOutcome(runVersionCommand(context.version, options.format as 'human' | 'json'))
		})

	const artifact = program.command('artifact')
		.description('Create, inspect, update, delete, and list Artifacts.')
	artifact.command('create')
		.description('Create a draft Artifact.')
		.requiredOption('--kind <kind>')
		.requiredOption('--title <text>')
		.option('--status <status>')
		.option('--body <markdown>')
		.option('--body-file <path>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (options: Record<string, unknown>) => {
			setOutcome(await runArtifactCreateCommand(options, { cwd: io.cwd }))
		})
	artifact.command('get')
		.description('Get an Artifact by UUIDv7.')
		.argument('<id>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (id: string, options: Record<string, unknown>) => {
			setOutcome(await runArtifactGetCommand(id, options, { cwd: io.cwd }))
		})
	artifact.command('update')
		.description('Update only title/body content of an Artifact.')
		.argument('<id>')
		.option('--title <text>')
		.option('--body <markdown>')
		.option('--body-file <path>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (id: string, options: Record<string, unknown>) => {
			setOutcome(await runArtifactUpdateCommand(id, options, { cwd: io.cwd }))
		})
	artifact.command('delete')
		.description('Physically delete a draft Artifact with no incoming relations.')
		.argument('<id>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (id: string, options: Record<string, unknown>) => {
			setOutcome(await runArtifactDeleteCommand(id, options, { cwd: io.cwd }))
		})
	artifact.command('list')
		.description('List Artifacts in deterministic canonical-path order.')
		.option('--kind <kind>')
		.option('--status <status>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (options: Record<string, unknown>) => {
			setOutcome(await runArtifactListCommand(options, { cwd: io.cwd }))
		})

	const relation = program.command('relation')
		.description('Manage source-owned Artifact relations.')
	relation.command('add')
		.description('Add a relation, or perform an invariant-aware supersede.')
		.argument('<source-id>')
		.argument('<target-id>')
		.requiredOption('--type <type>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (sourceId: string, targetId: string, options: Record<string, unknown>) => {
			setOutcome(await runRelationAddCommand(sourceId, targetId, options, { cwd: io.cwd }))
		})
	relation.command('remove')
		.description('Remove a source-owned relation.')
		.argument('<source-id>')
		.argument('<target-id>')
		.requiredOption('--type <type>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (sourceId: string, targetId: string, options: Record<string, unknown>) => {
			setOutcome(await runRelationRemoveCommand(sourceId, targetId, options, { cwd: io.cwd }))
		})
	relation.command('list')
		.description('List outgoing, incoming, or all relations.')
		.option('--artifact <id>')
		.option('--direction <direction>')
		.option('--type <type>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (options: Record<string, unknown>) => {
			setOutcome(await runRelationListCommand(options, { cwd: io.cwd }))
		})

	const lifecycle = program.command('lifecycle')
		.description('Perform invariant-aware lifecycle transitions.')
	lifecycle.command('activate')
		.description('Activate a complete draft Artifact.')
		.argument('<id>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (id: string, options: Record<string, unknown>) => {
			setOutcome(await runLifecycleActivateCommand(id, options, { cwd: io.cwd }))
		})
	lifecycle.command('complete')
		.description('Complete a draft CHG Artifact.')
		.argument('<id>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (id: string, options: Record<string, unknown>) => {
			setOutcome(await runLifecycleCompleteCommand(id, options, { cwd: io.cwd }))
		})
	lifecycle.command('retire')
		.description('Retire a draft or active Artifact.')
		.argument('<id>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (id: string, options: Record<string, unknown>) => {
			setOutcome(await runLifecycleRetireCommand(id, options, { cwd: io.cwd }))
		})
	lifecycle.command('supersede')
		.description('Activate replacement, transfer current replacement targets, then supersede the old Artifact.')
		.argument('[replacement-id]')
		.argument('[replaced-id]')
		.option('--replacement <id>')
		.option('--replaced <id>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (replacementId: string | undefined, replacedId: string | undefined, options: Record<string, unknown>) => {
			setOutcome(await runLifecycleSupersedeCommand(replacementId, replacedId, options, { cwd: io.cwd }))
		})

	const resource = program.command('resource')
		.description('Manage Artifact-owned Resource descriptors.')
	resource.command('add')
		.description('Add a local or https Resource descriptor.')
		.argument('<artifact-id>')
		.requiredOption('--location <location>')
		.requiredOption('--role <role>')
		.requiredOption('--media-type <mediaType>')
		.option('--description <text>', '')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (artifactId: string, options: Record<string, unknown>) => {
			setOutcome(await runResourceAddCommand(artifactId, options, { cwd: io.cwd }))
		})
	resource.command('remove')
		.description('Remove an owned Resource descriptor.')
		.argument('<artifact-id>')
		.argument('<location>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (artifactId: string, location: string, options: Record<string, unknown>) => {
			setOutcome(await runResourceRemoveCommand(artifactId, location, options, { cwd: io.cwd }))
		})
	resource.command('list')
		.description('List owned Resource descriptors.')
		.option('--artifact <id>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (options: Record<string, unknown>) => {
			setOutcome(await runResourceListCommand(options, { cwd: io.cwd }))
		})
	resource.command('read')
		.description('Read a local Resource; https URLs are never fetched.')
		.argument('<artifact-id>')
		.argument('<location>')
		.addOption(new Option('--project <project-root>', 'project root; defaults to the nearest workspace'))
		.addOption(formatOption())
		.option('--no-color')
		.action(async (artifactId: string, location: string, options: Record<string, unknown>) => {
			setOutcome(await runResourceReadCommand(artifactId, location, options, { cwd: io.cwd }))
		})

	program.action(() => {
		setOutcome({ exitCode: 0, stdout: `${GENERAL_HELP}\n`, stderr: '' })
	})
	return program
}

export async function runCli(argv: readonly string[], io: CliIO, context: RunCliContext): Promise<CommandOutcome> {
	let outcome: CommandOutcome | undefined
	const setOutcome = (value: CommandOutcome): void => {
		outcome = value
	}
	const program = buildProgram(io, context, setOutcome)
	try {
		await program.parseAsync([...argv], { from: 'user' })
		return outcome ?? { exitCode: 0, stdout: `${GENERAL_HELP}\n`, stderr: '' }
	}
	catch (error) {
		const jsonRequested = argv.some((argument, index) => (argument === '--format' && argv[index + 1] === 'json') || argument === '--format=json')
		if (outcome && !(error instanceof CommanderError && error.exitCode !== 0 && jsonRequested))
			return outcome
		if (error instanceof CommanderError && jsonRequested) {
			const result = errorResultJson([diagnostic('SPEC-CLI-INVALID', error.message.replace(/^error:\s*/u, ''), {})])
			return { exitCode: error.exitCode === 0 ? 0 : 2, stdout: `${JSON.stringify(result)}\n`, stderr: '' }
		}
		if (error instanceof CommanderError)
			return { exitCode: error.exitCode === 0 ? 0 : 2, stdout: '', stderr: `${error.message}\n` }
		if (jsonRequested) {
			const result = errorResultJson([diagnostic('SPEC-CLI-INTERNAL', 'Internal CLI failure.', {})])
			return { exitCode: 3, stdout: `${JSON.stringify(result)}\n`, stderr: '' }
		}
		throw error
	}
}

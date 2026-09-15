import type { CommandOutcome } from './command-outcome'
import { Command, CommanderError, Option } from 'commander'
import { runInitCommand } from './commands/init'
import { runValidateCommand } from './commands/validate'
import { runVersionCommand } from './commands/version'

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
		if (outcome)
			return outcome
		if (error instanceof CommanderError)
			return { exitCode: error.exitCode === 0 ? 0 : 2, stdout: '', stderr: `${error.message}\n` }
		throw error
	}
}

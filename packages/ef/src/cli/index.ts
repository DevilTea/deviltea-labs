/**
 * Argument parsing, output transport, and exit-code mapping.
 *
 * Public re-export surface for the EF Core CLI layer. `runCli` is the
 * complete, side-effect-free (aside from real Git process execution and
 * real filesystem I/O against the caller-supplied `cwd`) command
 * implementation: it never calls `process.exit()` and never writes directly
 * to `process.stdout`/`process.stderr`. Only `src/cli.ts` does that, using
 * the `CommandOutcome` this returns.
 */

export type { CommandOutcome } from './command-outcome'
export type { ExitCode } from './exit'
export type { CliIO, RunCliContext } from './program'
export { runCli } from './program'

/**
 * The uniform shape every command handler returns (00-implementation-decisions.md
 * "Domain and application code return typed results and do not call
 * `process.exit()`"; extended here to the CLI layer itself so `process.exit`
 * is called only once, at the top-level entry point in `src/cli.ts`).
 *
 * `stdout` is a `Uint8Array` only for `ef resource read`'s raw-byte success
 * transport; every other command produces a `string` (either one JSON line
 * or human text).
 */

import type { ExitCode } from './exit'

export interface CommandOutcome {
	exitCode: ExitCode
	stdout: string | Uint8Array
	stderr: string
}

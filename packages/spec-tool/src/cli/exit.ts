/**
 * The four Core exit codes and their priority (13-cli-contract.md "Exit
 * Codes"; 09-validation.md "Priority"). Every stable exit-code decision in
 * the CLI layer goes through `ExitCode`/`highestExitCode` so priority is
 * computed in exactly one place.
 */

export type ExitCode = 0 | 1 | 2 | 3

/** `3 > 2 > 1 > 0` (13-cli-contract.md "Priority"). Never returns lower than every input. */
export function highestExitCode(...codes: readonly ExitCode[]): ExitCode {
	let highest: ExitCode = 0
	for (const code of codes) {
		if (code > highest)
			highest = code
	}
	return highest
}

export interface CommandOutcome {
	exitCode: 0 | 1 | 2 | 3
	stdout: string
	stderr: string
}

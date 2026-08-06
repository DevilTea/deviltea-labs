/**
 * Mutation authorization classification (13-cli-contract.md "Mutation
 * Planning and Authorization").
 *
 * Pure decision logic only: given the three authorization-relevant flags
 * (`--dry-run`, `--yes`, and whether the invocation forbids prompts --
 * `--no-input`, or its `--format json` implication), decide which of the
 * four documented paths applies. The command layer performs the actual
 * interactive confirmation (async, requires real I/O) and the actual
 * plan application; this module only decides which of those the command
 * must do.
 *
 * `--dry-run` never requires `--yes` ("It does not require `--yes`") and is
 * checked first regardless of the other two flags. Authorization here never
 * bypasses validation, collision, immutability, ownership, or
 * target-existence rules -- those remain the plan-computation and
 * plan-application layers' own responsibility.
 */

export type MutationAuthorizationClassification
	= | 'dry-run'
		| 'direct'
		| 'needs-confirmation'
		| 'missing-authorization'

export interface MutationAuthorizationInput {
	dryRun: boolean
	yes: boolean
	/** `true` for an explicit `--no-input`, or implied by `--format json` (13-cli-contract.md "JSON mode implies `--no-input`"). */
	noInput: boolean
}

export function classifyMutationAuthorization(input: MutationAuthorizationInput): MutationAuthorizationClassification {
	if (input.dryRun)
		return 'dry-run'
	if (input.yes)
		return 'direct'
	if (input.noInput)
		return 'missing-authorization'
	return 'needs-confirmation'
}

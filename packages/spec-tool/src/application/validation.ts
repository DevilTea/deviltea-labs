import type { ValidationSummary } from './snapshot-validation'
import { aggregateDiagnostics } from '../domain/diagnostics'
import { validateRelationGraph, validateResourceIntegrity } from './mutations'
import { loadSnapshotFromWorkingTree } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

/** Validate the complete current-workspace MVP boundary without consulting Git or network content. */
export async function validateCurrentWorkspace(root: string): Promise<ValidationSummary> {
	const loaded = await loadSnapshotFromWorkingTree(root)
	const structural = validateSnapshot(loaded.snapshot)
	const diagnostics = aggregateDiagnostics([
		...structural.diagnostics,
		...validateRelationGraph(loaded.snapshot.artifacts),
		...await validateResourceIntegrity(root, loaded.snapshot.artifacts),
	])
	return {
		...structural,
		valid: diagnostics.length === 0,
		diagnostics,
	}
}

/**
 * `ef resource read <owner-id> <location>` (13-cli-contract.md "Resource
 * Reading").
 *
 * A raw-byte transport command: it never accepts `--format`, never produces
 * a JSON envelope, and its stderr diagnostic on failure is explicitly
 * documented as non-contractual ("Callers MUST NOT treat stderr as a stable
 * machine envelope for this raw byte transport command"). Only the stable
 * exit code and, on success, the exact raw bytes on stdout are the contract.
 *
 * The failure table's six rows collapse to three exit-2 conditions (owner
 * missing, no matching descriptor anywhere, or the location is declared by a
 * different Artifact) followed by two exit-1 conditions (missing/wrong-type
 * managed file, forbidden symlink) and a final exit-2 read failure. An
 * external (`http(s)://`) location matched by descriptor shape but never
 * locally readable is treated as the exit-1 "managed local file is missing"
 * case, since this command reads only local Resources and never fetches a
 * URL -- there is no dedicated row for that condition in 13-cli-contract.md's
 * table, and "missing" is the closest fit.
 */

import type { GitExecutor } from '../../git/executor'
import type { CommandOutcome } from '../command-outcome'
import path from 'pathe'
import { loadSnapshotFromWorkingTree } from '../../application/snapshot'
import { validateSnapshot } from '../../application/snapshot-validation'
import { validateResourceDescriptors } from '../../domain/resources'
import { isRegularFile, isSymlink, readFileBytes } from '../../platform/fs-facts'
import { pathComponents } from '../../repository/symlinks'
import { resolveProject } from '../project-context'

/**
 * `EF-RES-004`/`EF-RES-007`/`EF-RES-014` are exactly the lexical/ownership
 * findings a standalone descriptor validator can report without project or
 * filesystem context (06-resources.md "A standalone descriptor validator can
 * check ... URL syntax"). Re-running `validateResourceDescriptors` against
 * only the selected descriptor's `location` reuses that same domain logic
 * (rather than reimplementing root-escape/owner-directory checks here) to
 * decide whether the exact descriptor this command is about to read is one
 * repository integrity already rejects.
 */
const REJECTED_DESCRIPTOR_CODES: ReadonlySet<string> = new Set(['EF-RES-004', 'EF-RES-007', 'EF-RES-014'])

export interface ResourceReadOptions {
	project?: string
}

export interface ResourceReadDeps {
	cwd: string
	executor: GitExecutor
}

function failure(exitCode: 1 | 2, message: string): CommandOutcome {
	return { exitCode, stdout: new Uint8Array(0), stderr: `${message}\n` }
}

function isExternalLocation(location: string): boolean {
	return location.startsWith('http://') || location.startsWith('https://')
}

export async function runResourceReadCommand(ownerId: string, location: string, options: ResourceReadOptions, deps: ResourceReadDeps): Promise<CommandOutcome> {
	const resolved = await resolveProject({ cwd: deps.cwd, explicitProject: options.project }, deps.executor)
	if (!resolved.ok)
		return failure(2, `EF project could not be resolved: ${resolved.message}`)

	const { root } = resolved.context

	const loaded = await loadSnapshotFromWorkingTree(root)
	if (!loaded.ok)
		return failure(2, `EF project snapshot could not be loaded: ${loaded.message}`)

	const validation = validateSnapshot(loaded.snapshot)

	// ---- (1) owner Artifact exists -------------------------------------------

	const owner = validation.byId.get(ownerId)
	if (!owner)
		return failure(2, `Artifact '${ownerId}' does not exist.`)

	// ---- (2)/(3) descriptor declares the exact location, owned by `ownerId` --

	const descriptor = owner.envelope.resources.find(r => r.location === location)
	if (!descriptor) {
		const owners = validation.resourceOwnership.get(location) ?? []
		if (owners.length > 0 && !owners.includes(ownerId))
			return failure(2, `Location '${location}' is declared by a different Artifact than '${ownerId}'.`)
		return failure(2, `Artifact '${ownerId}' declares no descriptor with the exact location '${location}'.`)
	}

	// ---- (4)/(5) managed local file exists, is a regular file, and is not a --
	// ---- forbidden symlink ----------------------------------------------------

	if (isExternalLocation(location))
		return failure(1, `Location '${location}' is an external URL, not a managed local file.`)

	// Reject a descriptor whose `location` repository integrity already
	// invalidates (root escape, backslash/segment violation, wrong-scheme, or
	// declared outside the owner's managed Resource directory) before ever
	// resolving it against the filesystem -- `path.join(root, location)` below
	// would otherwise happily walk a `../`-laden location outside the project.
	const descriptorDiagnostics = validateResourceDescriptors({ id: ownerId, resources: [{ location }] }, owner.path)
		.filter(d => REJECTED_DESCRIPTOR_CODES.has(d.code))
	if (descriptorDiagnostics.length > 0)
		return failure(1, `Descriptor location '${location}' violates repository integrity: ${descriptorDiagnostics[0]!.message}`)

	const absolutePath = path.join(root, location)

	// lstat every existing path component from `.engineering` down to the file
	// itself: a symlinked ancestor directory (e.g. `.engineering/resources/
	// REQ-001` replaced with a symlink to an external directory) is just as
	// much a forbidden symlink as the final component being one, even though
	// the final component's own `lstat` would report a plain file.
	for (const component of pathComponents(location)) {
		if (await isSymlink(path.join(root, component)))
			return failure(1, `Managed path '${component}' is a forbidden symlink.`)
	}

	if (!(await isRegularFile(absolutePath)))
		return failure(1, `Managed local file '${location}' is missing or is not a regular file.`)

	// ---- (6) the file is readable ---------------------------------------------

	try {
		const bytes = await readFileBytes(absolutePath)
		return { exitCode: 0, stdout: bytes, stderr: '' }
	}
	catch (error) {
		return failure(2, `Managed local file '${location}' could not be read: ${(error as Error).message}`)
	}
}

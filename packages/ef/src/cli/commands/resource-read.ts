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
import { readRegularFileNoFollow } from '../../platform/fs-facts'
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

	// A local Resource location MUST have exactly one owning Artifact across
	// the whole project (06-resources.md exclusive local ownership; `EF-RES-
	// 009`). Finding `descriptor` above only proves `ownerId`'s OWN envelope
	// declares `location` -- it says nothing about whether some OTHER
	// Artifact ALSO declares the identical local path, which is exactly the
	// condition the project-wide `resourceOwnership` index (populated from
	// every Artifact's descriptors, local locations only) exists to catch.
	// Without this check, a location claimed by more than one Artifact could
	// still be read to completion through whichever claimant happens to be
	// named, even though the repository is invalid.
	const owners = validation.resourceOwnership.get(location) ?? []
	if (owners.length !== 1 || owners[0] !== ownerId)
		return failure(1, `Location '${location}' has more than one declared owner, which repository integrity forbids.`)

	// Reject a descriptor whose `location` repository integrity already
	// invalidates (root escape, backslash/segment violation, wrong-scheme, or
	// declared outside the owner's managed Resource directory) before ever
	// resolving it against the filesystem -- `path.join(root, location)` below
	// would otherwise happily walk a `../`-laden location outside the project.
	const descriptorDiagnostics = validateResourceDescriptors({ id: ownerId, resources: [{ location }] }, owner.path)
		.filter(d => REJECTED_DESCRIPTOR_CODES.has(d.code))
	if (descriptorDiagnostics.length > 0)
		return failure(1, `Descriptor location '${location}' violates repository integrity: ${descriptorDiagnostics[0]!.message}`)

	// Reject a location the project-wide validation already flagged with an
	// error-severity finding keyed to this exact location string -- most
	// notably `EF-FS-006` (a declared path that is not Unicode-NFC-normalized,
	// or that does not exactly match the on-disk entry once case is
	// considered). Path-integrity findings like this are keyed by the bare
	// location text (not by owner/artifactId, unlike the descriptor-shape
	// findings above), so they are found by scanning for that instead.
	const locationDiagnostics = validation.diagnostics.filter(d => d.severity === 'error' && d.path === location)
	if (locationDiagnostics.length > 0)
		return failure(1, `Location '${location}' violates repository integrity: ${locationDiagnostics[0]!.message}`)

	const absolutePath = path.join(root, location)

	// `loaded.snapshot.entryKinds` was built from an exact-string-keyed,
	// case-preserving directory listing (`walkDirectory`'s real `readdir`
	// entries; a symlinked ancestor is recorded as `'symlink'` and never
	// descended into, so nothing beneath it is ever recorded as `'file'`
	// either). Requiring `location` itself to be a `'file'` key of it closes
	// the gap that resolving `absolutePath` through the live filesystem alone
	// cannot: a file whose actual on-disk name differs from `location` only in
	// case or Unicode normalization on a case-insensitive (but
	// case-preserving) filesystem.
	if (loaded.snapshot.entryKinds.get(location) !== 'file')
		return failure(1, `Managed local file '${location}' is missing or is not a regular file.`)

	// ---- (5)/(6) the managed path is not a forbidden symlink, and the file --
	// ---- is readable ------------------------------------------------------------
	//
	// `readRegularFileNoFollow` re-verifies all of this live, right before the
	// read, rather than relying solely on the snapshot's (by-now possibly
	// stale) observation above: `lstat` classifies `absolutePath` itself
	// before ever opening it (a symlink, directory, FIFO, socket, or device is
	// refused outright), the file is then opened with `O_NOFOLLOW`, and --
	// via `containmentRoot: root` -- every directory component between the
	// project root and `absolutePath` (e.g. a `.engineering/resources/
	// REQ-001` replaced with a symlink to an external directory, even though
	// the final component reached through it is a perfectly ordinary file) is
	// `lstat`'d as a non-symlink directory both before and after the read
	// (13-cli-contract.md's "The managed path or its state violates
	// repository integrity, such as a forbidden symlink" row; see
	// `platform/fs-facts.ts`'s `readRegularFileNoFollow` doc for exactly what
	// this closes that a one-shot symlink check right before the read cannot:
	// the entry being swapped in the narrow window between that check and the
	// read itself).
	let readResult
	try {
		readResult = await readRegularFileNoFollow(absolutePath, undefined, root)
	}
	catch (error) {
		return failure(2, `Managed local file '${location}' could not be read: ${(error as Error).message}`)
	}

	if (readResult.kind === 'ok')
		return { exitCode: 0, stdout: readResult.bytes, stderr: '' }

	if (readResult.kind === 'not-found')
		return failure(1, `Managed local file '${location}' is missing or is not a regular file.`)

	// `readResult.kind` is `'not-a-regular-file'` (a symlink -- or any other
	// non-regular entry -- at the final component) or `'identity-mismatch'`
	// (a forbidden ancestor symlink, or the entry replaced between being
	// observed and being opened): both are repository-integrity violations
	// under 13-cli-contract.md's "forbidden symlink" row.
	return failure(1, `Managed path '${location}' violates repository integrity: it is a forbidden symlink, or was replaced between being observed and being read.`)
}

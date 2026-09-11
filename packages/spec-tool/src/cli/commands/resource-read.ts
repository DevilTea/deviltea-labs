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

import type { SnapshotValidationResult } from '../../application/snapshot-validation'
import type { GitExecutor } from '../../git/executor'
import type { CommandOutcome } from '../command-outcome'
import path from 'pathe'
import { validateResourceDescriptors } from '../../domain/resources'
import { readRegularFileNoFollow } from '../../platform/fs-facts'
import { loadWorkingTreeContext } from '../working-tree-context'

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

/**
 * Whether `validation.resourceOwnership` can be trusted as a COMPLETE,
 * project-wide index of every local Resource location's owner(s) (Finding 3,
 * ninth round). `resourceOwnership` is built only from envelopes that decoded
 * to completion (`snapshot-validation.ts`), so it is silently blind to a
 * second Artifact anywhere in the project whose true declared `resources`
 * content is not what was actually indexed:
 *
 * - An Artifact whose envelope never decoded at all
 *   (`!validation.graphTrustworthy`) is fully present in the bound snapshot,
 *   yet contributes nothing to `resourceOwnership` -- its raw, unparsed bytes
 *   could still declare the exact `location` this command is about to read.
 * - An Artifact whose top-level `resources` key was itself duplicated
 *   (`EF-ENV-005`, recorded per-field in `validation.envelopeFieldLossById`)
 *   has one candidate `resources` array silently discarded by decoding's
 *   first-occurrence selection -- the discarded array, not the one actually
 *   indexed, could be the one declaring `location`.
 *
 * Either condition means exclusive local-Resource ownership can never be
 * proven project-wide, regardless of what `resourceOwnership.get(location)`
 * itself currently reports for this one `location` -- the missing/discarded
 * declaration could belong to any Artifact, not only ones already known to
 * exist for this exact location.
 */
function resourceOwnershipWitnessEstablished(validation: SnapshotValidationResult): boolean {
	if (!validation.graphTrustworthy)
		return false
	for (const fields of validation.envelopeFieldLossById.values()) {
		if (fields.has('resources'))
			return false
	}
	return true
}

export async function runResourceReadCommand(ownerId: string, location: string, options: ResourceReadOptions, deps: ResourceReadDeps): Promise<CommandOutcome> {
	// `loadWorkingTreeContext` (Finding 12, consolidated): resolves the
	// project, loads its snapshot bound to discovery's own `.engineering`
	// identity observation (Finding 4 -- previously missing here entirely, so
	// a transient snapshot that hid a second Artifact also declaring
	// `location` during enumeration could make `resourceOwnership` falsely
	// unique and let this command return bytes it should have refused), and
	// -- for implicit discovery only -- re-checks working-directory
	// association against the snapshot's own freshest configuration (Finding
	// 5 -- also previously missing here entirely).
	const loaded = await loadWorkingTreeContext({ cwd: deps.cwd, explicitProject: options.project }, deps.executor)
	if (!loaded.ok) {
		const message = loaded.stage === 'resolve'
			? `EF project could not be resolved: ${loaded.message}`
			: loaded.stage === 'load'
				? `EF project snapshot could not be loaded: ${loaded.message}`
				: `EF project working-directory association could not be verified: ${loaded.message}`
		return failure(2, message)
	}

	const { root, snapshot, validation } = loaded.context

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
	//
	// `resourceOwnership` itself, though, is derived only from envelopes that
	// decoded to completion (Finding 3, ninth round): before trusting whatever
	// it reports for `location` specifically, the project-wide witness that
	// index depends on must itself be establishable -- otherwise a second
	// Artifact's true declared content (undecoded entirely, or discarded by a
	// duplicate `resources` key) could be hiding a claimant `owners` below
	// would never see.
	if (!resourceOwnershipWitnessEstablished(validation))
		return failure(1, 'Repository-wide Resource ownership could not be established as trustworthy (an undecoded or identity-uncertain Artifact exists, or a Resource-owning Artifact\'s \'resources\' field is ambiguous), so exclusive ownership cannot be verified.')

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

	// `snapshot.entryKinds` was built from an exact-string-keyed,
	// case-preserving directory listing (`walkDirectory`'s real `readdir`
	// entries; a symlinked ancestor is recorded as `'symlink'` and never
	// descended into, so nothing beneath it is ever recorded as `'file'`
	// either). Requiring `location` itself to be a `'file'` key of it closes
	// the gap that resolving `absolutePath` through the live filesystem alone
	// cannot: a file whose actual on-disk name differs from `location` only in
	// case or Unicode normalization on a case-insensitive (but
	// case-preserving) filesystem.
	if (snapshot.entryKinds.get(location) !== 'file')
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

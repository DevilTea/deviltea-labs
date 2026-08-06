/**
 * Project snapshot loading (09-validation.md "Discovery"/"Parse" phases;
 * 11-filesystem-and-config.md canonical layout and text-normalization
 * inputs).
 *
 * A `ProjectSnapshot` is the complete, already-read input to
 * `validateSnapshot` (./snapshot-validation): configuration bytes and decode
 * result, every discovered Artifact file's bytes plus its parsed
 * frontmatter/envelope/body, every file beneath the managed Resource root,
 * and a flat map of every discovered path beneath `.engineering` to its kind
 * (file/directory/symlink) -- sufficient for the managed-symlink policy and
 * local-Resource-file-existence checks without further filesystem or Git
 * access. It has exactly the same shape whether loaded from the working tree
 * or from a materialized Git commit tree, so `validateSnapshot` never needs
 * to know which source produced it.
 *
 * Both loaders return a typed result rather than throwing (00-implementation-decisions.md:
 * "Domain and application code return typed results and do not call
 * `process.exit()`").
 */

import type { Diagnostic } from '../domain/diagnostics'
import type { DecodeEnvelopeResult } from '../domain/envelope'
import type { GitRepository, GitTreeEntry } from '../git/repository'
import type { FrontmatterSplitResult, ParsedFrontmatterDocument } from '../parsing/frontmatter'
import type {
	ExtractedSections,
	ParseBodyResult,
} from '../parsing/markdown'
import type { WalkEntry } from '../platform/fs-facts'
import type { DecodeConfigResult } from '../repository/config'
import path from 'pathe'
import { decodeEnvelope } from '../domain/envelope'
import { parseFrontmatterDocument, splitFrontmatter } from '../parsing/frontmatter'
import { extractSections, parseBody } from '../parsing/markdown'
import { isDirectory, isSymlink, readFileBytes, walkDirectory } from '../platform/fs-facts'
import { decodeConfig } from '../repository/config'
import { listArtifactFiles } from '../repository/layout'

const ENGINEERING_DIR = '.engineering'
const CONFIG_PATH = '.engineering/ef.yaml'
const GITIGNORE_PATH = '.engineering/.gitignore'
const RESOURCE_ROOT_PREFIX = '.engineering/resources/'

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type SnapshotEntryKind = 'file' | 'directory' | 'symlink'

export type SnapshotSource
	= | { kind: 'working-tree', projectRoot: string }
		| { kind: 'commit', commitOid: string }

/** One file discovered beneath the managed Resource root (`.engineering/resources/`). */
export interface SnapshotResourceFile {
	/** Project-relative path, `/` separators. */
	path: string
	kind: SnapshotEntryKind
}

/** One discovered Artifact file: its raw bytes and every pipeline-phase result derived from them. */
export interface SnapshotArtifactFile {
	/** Project-relative path, `/` separators. */
	path: string
	bytes: Uint8Array
	/** Best-effort UTF-8 decoding of `bytes` (never throws; invalid sequences become U+FFFD). */
	text: string
	frontmatter: FrontmatterSplitResult
	/** Present only when `frontmatter.ok`. */
	document: ParsedFrontmatterDocument | undefined
	/** Present only when `frontmatter.ok`. May itself carry a `null` envelope. */
	envelope: DecodeEnvelopeResult | undefined
	/** Present only when `frontmatter.ok`. */
	body: ParseBodyResult | undefined
	/** Present only when `frontmatter.ok && body.ok`. */
	sections: ExtractedSections | undefined
}

export interface ProjectSnapshot {
	source: SnapshotSource
	/** Raw bytes of `.engineering/ef.yaml`, or `undefined` when it does not exist in this snapshot. */
	configBytes: Uint8Array | undefined
	config: DecodeConfigResult
	/** Raw bytes of `.engineering/.gitignore`, or `undefined` when it does not exist in this snapshot. */
	gitignoreBytes: Uint8Array | undefined
	/** Every discovered Artifact file, bytewise sorted by path (`listArtifactFiles`' own ordering). */
	artifacts: SnapshotArtifactFile[]
	/** Every file, directory, and symlink discovered beneath `.engineering/resources/`. */
	resourceFiles: SnapshotResourceFile[]
	/** Every discovered path beneath (and including) `.engineering` itself, mapped to its kind. */
	entryKinds: ReadonlyMap<string, SnapshotEntryKind>
	/** `EF-FS-003` canonical-layout findings, from `listArtifactFiles`. */
	layoutDiagnostics: Diagnostic[]
}

export type LoadSnapshotFailureReason
	= | 'engineering-missing'
		| 'read-error'
		| 'git-unavailable'
		| 'commit-not-found'

export interface LoadSnapshotFailure {
	ok: false
	reason: LoadSnapshotFailureReason
	message: string
}

export interface LoadSnapshotSuccess {
	ok: true
	snapshot: ProjectSnapshot
}

export type LoadSnapshotResult = LoadSnapshotSuccess | LoadSnapshotFailure

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

function decodeUtf8(bytes: Uint8Array): string {
	return utf8Decoder.decode(bytes)
}

/** Build one `SnapshotArtifactFile`, running every phase that doesn't need project-wide context. */
function buildArtifactFile(filePath: string, bytes: Uint8Array): SnapshotArtifactFile {
	const text = decodeUtf8(bytes)
	const frontmatter = splitFrontmatter(text)

	if (!frontmatter.ok) {
		return { path: filePath, bytes, text, frontmatter, document: undefined, envelope: undefined, body: undefined, sections: undefined }
	}

	const document = parseFrontmatterDocument(frontmatter.frontmatterText, filePath, { startLine: 2 })
	const envelope = decodeEnvelope({ mapping: document.mapping, locate: document.locate }, filePath)
	const body = parseBody(frontmatter.bodyText, frontmatter.bodyStartLine - 1)
	const sections = body.ok ? extractSections(body.root) : undefined

	return { path: filePath, bytes, text, frontmatter, document, envelope, body, sections }
}

function isUnderResourceRoot(projectRelativePath: string): boolean {
	return projectRelativePath.startsWith(RESOURCE_ROOT_PREFIX)
}

// ---------------------------------------------------------------------------
// loadSnapshotFromWorkingTree
// ---------------------------------------------------------------------------

export interface SnapshotFsDeps {
	isDirectory: (target: string) => Promise<boolean>
	isSymlink: (target: string) => Promise<boolean>
	walkDirectory: (root: string) => Promise<WalkEntry[]>
	readFileBytes: (target: string) => Promise<Uint8Array>
}

/** Real filesystem access via `platform/fs-facts.ts`. */
export const defaultSnapshotFsDeps: SnapshotFsDeps = { isDirectory, isSymlink, walkDirectory, readFileBytes }

async function tryReadFileBytes(deps: SnapshotFsDeps, target: string): Promise<Uint8Array | undefined> {
	try {
		return await deps.readFileBytes(target)
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return undefined
		throw error
	}
}

/**
 * Load a `ProjectSnapshot` from `projectRoot`'s working tree. `projectRoot`
 * is assumed already verified (e.g. by `repository/discovery.ts`) to be the
 * Git worktree root that directly contains `.engineering`; this function
 * re-verifies only that `.engineering` is a directory before reading it.
 */
export async function loadSnapshotFromWorkingTree(projectRoot: string, deps: SnapshotFsDeps = defaultSnapshotFsDeps): Promise<LoadSnapshotResult> {
	try {
		const engineeringPath = path.join(projectRoot, ENGINEERING_DIR)

		if (!(await deps.isDirectory(engineeringPath)))
			return { ok: false, reason: 'engineering-missing', message: `'${engineeringPath}' is not a directory.` }

		const walked = await deps.walkDirectory(engineeringPath)

		const entryKinds = new Map<string, SnapshotEntryKind>()
		entryKinds.set(ENGINEERING_DIR, (await deps.isSymlink(engineeringPath)) ? 'symlink' : 'directory')
		for (const entry of walked) {
			const kind: SnapshotEntryKind = entry.isSymlink ? 'symlink' : entry.isDirectory ? 'directory' : 'file'
			entryKinds.set(`${ENGINEERING_DIR}/${entry.relativePath}`, kind)
		}

		const { artifactFiles, diagnostics: layoutDiagnostics } = listArtifactFiles(walked)

		const configBytes = await tryReadFileBytes(deps, path.join(projectRoot, CONFIG_PATH))
		const config = configBytes !== undefined ? decodeConfig(decodeUtf8(configBytes), CONFIG_PATH) : { config: null, diagnostics: [] }
		const gitignoreBytes = await tryReadFileBytes(deps, path.join(projectRoot, GITIGNORE_PATH))

		const artifacts: SnapshotArtifactFile[] = []
		for (const relativePath of artifactFiles) {
			const bytes = await tryReadFileBytes(deps, path.join(projectRoot, relativePath))
			if (bytes === undefined)
				continue
			artifacts.push(buildArtifactFile(relativePath, bytes))
		}

		const resourceFiles: SnapshotResourceFile[] = [...entryKinds.entries()]
			.filter(([entryPath]) => isUnderResourceRoot(entryPath))
			.map(([entryPath, kind]) => ({ path: entryPath, kind }))

		return {
			ok: true,
			snapshot: {
				source: { kind: 'working-tree', projectRoot },
				configBytes,
				config,
				gitignoreBytes,
				artifacts,
				resourceFiles,
				entryKinds,
				layoutDiagnostics,
			},
		}
	}
	catch (error) {
		return { ok: false, reason: 'read-error', message: (error as Error).message }
	}
}

// ---------------------------------------------------------------------------
// loadSnapshotFromCommit
// ---------------------------------------------------------------------------

class GitUnavailableError extends Error {}

function entryKindOf(entry: GitTreeEntry): SnapshotEntryKind {
	if (entry.mode === '120000')
		return 'symlink'
	return entry.type === 'tree' ? 'directory' : 'file'
}

async function readBlobOrThrow(git: GitRepository, entry: GitTreeEntry | undefined): Promise<Uint8Array | undefined> {
	if (!entry)
		return undefined
	const result = await git.readBlob(entry.oid)
	if (result.kind === 'git-unavailable')
		throw new GitUnavailableError(result.message)
	if (result.kind !== 'resolved')
		return undefined
	return result.bytes
}

/**
 * Load a `ProjectSnapshot` by materializing `commitOid`'s complete tree
 * (09-validation.md "Trusted proposed commit": "Validation materializes the
 * commit and validates its complete tree"), without touching the working
 * tree, index, or `HEAD`. Only entries beneath `.engineering` are retained;
 * everything else in the commit tree is ignored.
 */
export async function loadSnapshotFromCommit(git: GitRepository, commitOid: string): Promise<LoadSnapshotResult> {
	try {
		const treeResult = await git.readTree(commitOid)
		if (treeResult.kind === 'git-unavailable')
			return { ok: false, reason: 'git-unavailable', message: treeResult.message }
		if (treeResult.kind === 'missing')
			return { ok: false, reason: 'commit-not-found', message: `Commit '${commitOid}' could not be materialized.` }

		const engineeringEntries = treeResult.entries.filter(entry => entry.path === ENGINEERING_DIR || entry.path.startsWith(`${ENGINEERING_DIR}/`))

		const entryKinds = new Map<string, SnapshotEntryKind>()
		const blobEntries = new Map<string, GitTreeEntry>()
		for (const entry of engineeringEntries) {
			const kind = entryKindOf(entry)
			entryKinds.set(entry.path, kind)
			if (entry.type === 'blob')
				blobEntries.set(entry.path, entry)
		}

		const walkEntries: WalkEntry[] = engineeringEntries
			.filter(entry => entry.path !== ENGINEERING_DIR)
			.map((entry) => {
				const kind = entryKindOf(entry)
				return {
					relativePath: entry.path.slice(ENGINEERING_DIR.length + 1),
					isRegularFile: kind === 'file',
					isDirectory: kind === 'directory',
					isSymlink: kind === 'symlink',
				}
			})

		const { artifactFiles, diagnostics: layoutDiagnostics } = listArtifactFiles(walkEntries)

		const configBytes = await readBlobOrThrow(git, blobEntries.get(CONFIG_PATH))
		const config = configBytes !== undefined ? decodeConfig(decodeUtf8(configBytes), CONFIG_PATH) : { config: null, diagnostics: [] }
		const gitignoreBytes = await readBlobOrThrow(git, blobEntries.get(GITIGNORE_PATH))

		const artifacts: SnapshotArtifactFile[] = []
		for (const relativePath of artifactFiles) {
			const bytes = await readBlobOrThrow(git, blobEntries.get(relativePath))
			if (bytes === undefined)
				continue
			artifacts.push(buildArtifactFile(relativePath, bytes))
		}

		const resourceFiles: SnapshotResourceFile[] = [...entryKinds.entries()]
			.filter(([entryPath]) => isUnderResourceRoot(entryPath))
			.map(([entryPath, kind]) => ({ path: entryPath, kind }))

		return {
			ok: true,
			snapshot: {
				source: { kind: 'commit', commitOid },
				configBytes,
				config,
				gitignoreBytes,
				artifacts,
				resourceFiles,
				entryKinds,
				layoutDiagnostics,
			},
		}
	}
	catch (error) {
		if (error instanceof GitUnavailableError)
			return { ok: false, reason: 'git-unavailable', message: error.message }
		throw error
	}
}

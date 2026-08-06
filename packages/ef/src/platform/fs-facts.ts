/**
 * lstat-based filesystem facts for validators (11-filesystem-and-config.md
 * symlink policy: "use `lstat` on every applicable existing component and
 * reject symlinks").
 *
 * Every function here inspects the path itself rather than a symlink's
 * resolved target, and treats a missing path as a normal (non-throwing)
 * fact rather than an error. Validators consume these as prepared facts; this
 * module performs no validation logic of its own.
 */

import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'pathe'

async function tryLstat(target: string) {
	try {
		return await lstat(target)
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return undefined
		throw error
	}
}

/** `true` only for a regular file, per `lstat` (a symlink to a file is `false`: see module doc). */
export async function isRegularFile(target: string): Promise<boolean> {
	const stats = await tryLstat(target)
	return stats?.isFile() ?? false
}

/** `true` only for a real directory, per `lstat` (a symlink to a directory is `false`). */
export async function isDirectory(target: string): Promise<boolean> {
	const stats = await tryLstat(target)
	return stats?.isDirectory() ?? false
}

/** `true` for a symlink entry itself, regardless of what it resolves to or whether that target exists. */
export async function isSymlink(target: string): Promise<boolean> {
	const stats = await tryLstat(target)
	return stats?.isSymbolicLink() ?? false
}

export interface WalkEntry {
	/** Path relative to `root`, using `/` separators. */
	relativePath: string
	isRegularFile: boolean
	isDirectory: boolean
	isSymlink: boolean
}

async function walkInto(root: string, relativePrefix: string, out: WalkEntry[]): Promise<void> {
	const dirents: Dirent[] = await readdir(path.join(root, relativePrefix), { withFileTypes: true })

	for (const dirent of dirents) {
		const relativePath = relativePrefix ? path.join(relativePrefix, dirent.name) : dirent.name
		const absolutePath = path.join(root, relativePath)
		const stats = await lstat(absolutePath)
		const entry: WalkEntry = {
			relativePath,
			isRegularFile: stats.isFile(),
			isDirectory: stats.isDirectory(),
			isSymlink: stats.isSymbolicLink(),
		}
		out.push(entry)

		if (entry.isDirectory)
			await walkInto(root, relativePath, out)
	}
}

/**
 * Recursively list every entry beneath `root` (not including `root` itself)
 * with its `lstat`-derived type flags. A symlinked directory is reported as
 * a symlink entry and is not descended into.
 */
export async function walkDirectory(root: string): Promise<WalkEntry[]> {
	const out: WalkEntry[] = []
	await walkInto(root, '', out)
	return out
}

/** Read the complete raw bytes of `path`, exactly as stored, for text/BOM/normalization inspection. */
export async function readFileBytes(target: string): Promise<Uint8Array> {
	return readFile(target)
}

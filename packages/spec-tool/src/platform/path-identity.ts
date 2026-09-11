/**
 * Canonical path comparison for cross-source path equality
 * (11-filesystem-and-config.md "Project Discovery": "verify that the
 * candidate root is exactly the Git worktree root that directly contains
 * `.engineering`"; 00-implementation-decisions.md "Git Execution").
 *
 * Project discovery and `ef init`'s target-selection rule both compare a
 * path Git reported (`rev-parse --show-toplevel`) against a path this
 * process derived from the filesystem (an ascended `cwd`, or an explicit
 * `--project` value). These are two independent path sources that must
 * agree only in the location they denote, never in exact string form. On
 * Windows in particular, two strings naming the identical directory can
 * differ for reasons that have nothing to do with project structure:
 *
 *   - Git for Windows normalizes `rev-parse --show-toplevel` output to
 *     forward slashes; Node's `path`/`fs` primitives use backslashes.
 *   - A working directory sourced from an 8.3 short alias (e.g. a CI
 *     runner's `%TEMP%` resolving to `C:\Users\RUNNER~1\...`) names the same
 *     directory as its long form, which is what Git's own path resolution
 *     reports.
 *   - Drive letter case is not filesystem data; different tools emit it
 *     differently (`C:` vs `c:`) for the identical volume.
 *
 * `canonicalizeForComparison` resolves symlinks and 8.3 short names via
 * `fs.realpathSync.native` (falling back to the input path, unresolved, if
 * the path does not exist or cannot be stat'd -- a missing target is the
 * caller's own condition to handle, so this function never throws), strips
 * the Windows `\\?\` long-path prefix that `realpathSync.native` can
 * introduce, normalizes separators to `/` via `pathe`, and lower-cases a
 * leading Windows drive letter.
 *
 * The result is for equality comparison only. It MUST NOT be used as a path
 * that is stored, returned, or serialized -- every caller compares two
 * canonicalized values and discards them, keeping the original
 * (non-canonicalized) path for output, per the specification's requirement
 * that project-relative output paths stay exactly as computed. It also MUST
 * NOT be treated as a symlink check or a substitute for one:
 * `repository/symlinks.ts` separately rejects symlinks at managed paths via
 * `lstat`; resolving them here only lets two differently-shaped identifiers
 * for the same real location compare as equal, and does not change that
 * `lstat`-based rejection's semantics.
 */

import { realpathSync } from 'node:fs'
import path from 'pathe'

const WINDOWS_LONG_PATH_PREFIX = /^\\\\\?\\(?:UNC\\)?/

function stripWindowsLongPathPrefix(value: string): string {
	return value.replace(WINDOWS_LONG_PATH_PREFIX, '')
}

/**
 * Lower-cases a leading Windows drive letter (`C:/...` -> `c:/...`). Applied
 * unconditionally rather than gated on `process.platform === 'win32'`: the
 * pattern (a single ASCII letter, a colon, then `/`) cannot occur at the
 * start of a real POSIX absolute path -- those always start with `/` --
 * so this is a no-op everywhere except an actual drive-letter path, and
 * stays deterministically testable on any host platform.
 */
function lowerCaseDriveLetter(value: string): string {
	return /^[a-z]:\//i.test(value) ? value[0]!.toLowerCase() + value.slice(1) : value
}

/**
 * Canonicalize `absolutePath` for equality comparison against another path
 * from a possibly different source (Git output vs. filesystem-derived).
 * Never throws: a path that cannot be resolved (missing, inaccessible) is
 * normalized as given rather than failing.
 */
export function canonicalizeForComparison(absolutePath: string): string {
	let resolved: string
	try {
		resolved = realpathSync.native(absolutePath)
	}
	catch {
		resolved = absolutePath
	}

	return lowerCaseDriveLetter(path.normalize(stripWindowsLongPathPrefix(resolved)))
}

/**
 * `true` when `a` and `b` denote the same filesystem location, tolerating
 * symlinks, Windows 8.3 short names, drive-letter case, and `/` vs `\`
 * separators.
 */
export function isSameLocation(a: string, b: string): boolean {
	return canonicalizeForComparison(a) === canonicalizeForComparison(b)
}

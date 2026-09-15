import type { Diagnostic } from '../domain/diagnostics'
import type { ArtifactKind } from '../domain/model'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { diagnostic } from '../domain/diagnostics'
import { ARTIFACT_KINDS } from '../domain/model'
import { CONFIG_PATH } from './config'
import { discoverWorkspaceFiles } from './discovery'
import { CANONICAL_DIRECTORY_BY_KIND, SPEC_ROOT } from './layout'

export interface WorkspaceLayoutResult {
	diagnostics: Diagnostic[]
}

/** Validate the fixed `.spec/` directory shape before artifact decoding. */
export async function validateWorkspaceLayout(root: string): Promise<WorkspaceLayoutResult> {
	const diagnostics: Diagnostic[] = []
	try {
		if (!(await lstat(join(root, SPEC_ROOT))).isDirectory())
			diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `'${SPEC_ROOT}/' must be a directory.`, { path: SPEC_ROOT }))
	}
	catch {
		diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Missing workspace root '${SPEC_ROOT}/'.`, { path: SPEC_ROOT }))
		return { diagnostics }
	}
	for (const kind of ARTIFACT_KINDS) {
		const path = CANONICAL_DIRECTORY_BY_KIND[kind]
		try {
			if (!(await lstat(join(root, path))).isDirectory())
				diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Canonical directory '${path}/' must be a directory.`, { path }))
		}
		catch {
			diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Missing canonical directory '${path}/'.`, { path }))
		}
	}
	try {
		if (!(await lstat(join(root, CONFIG_PATH))).isFile())
			diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `'${CONFIG_PATH}' must be a regular file.`, { path: CONFIG_PATH }))
	}
	catch {
		diagnostics.push(diagnostic('SPEC-LAYOUT-INVALID', `Missing configuration '${CONFIG_PATH}'.`, { path: CONFIG_PATH }))
	}
	return { diagnostics }
}

export { discoverWorkspaceFiles }

export type CanonicalKindDirectory = ArtifactKind

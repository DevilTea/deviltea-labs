import type { Diagnostic } from '../domain/diagnostics'
import type { Artifact } from '../domain/model'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { diagnostic } from '../domain/diagnostics'
import { encodeArtifact } from '../domain/envelope'
import { generateUuidV7 } from '../domain/identity'
import { PLURAL_DIRECTORY_BY_KIND } from '../domain/model'
import { encodeConfig } from '../repository/config'
import { canonicalArtifactPath, SPEC_ROOT } from '../repository/layout'

export interface InitValues {
	title?: string
	vision?: string
	scope?: string
	nonGoals?: string
	context?: string
	terminology?: string
}

export interface InitPlan {
	root: string
	artifact: Artifact
	files: { path: string, content: string }[]
}

function nonEmpty(value: string | undefined, fallback: string): string {
	return value?.trim() ? value.trim() : fallback
}

function projectBody(title: string, values: InitValues): string {
	return [
		'## Vision',
		nonEmpty(values.vision, `This workspace records the specification for ${title}.`),
		'',
		'## Scope',
		nonEmpty(values.scope, 'The scope is defined by the active and draft Artifacts in this workspace.'),
		'',
		'## Non-goals',
		nonEmpty(values.nonGoals, 'Implementation details that are not specification content are outside this workspace.'),
		'',
		'## Context',
		nonEmpty(values.context, 'This project was initialized with the Spec-native workspace format.'),
		'',
		'## Terminology',
		nonEmpty(values.terminology, 'No project-specific terminology has been defined.'),
	].join('\n')
}

export function createProjectArtifact(values: InitValues = {}, id = generateUuidV7()): Artifact {
	const title = nonEmpty(values.title, 'Spec project')
	return {
		schema: 'spec/project@1',
		kind: 'project',
		id,
		title,
		status: 'active',
		relations: [],
		resources: [],
		body: projectBody(title, values),
	}
}

export function computeInitPlan(root: string, values: InitValues = {}, id?: string): InitPlan {
	const project = createProjectArtifact(values, id)
	const relativeProjectPath = canonicalArtifactPath('project', project.id)
	return {
		root: resolve(root),
		artifact: project,
		files: [
			{ path: '.spec/config.yaml', content: encodeConfig() },
			{ path: relativeProjectPath, content: encodeArtifact(project) },
		],
	}
}

export interface InitWorkspaceResult {
	ok: boolean
	plan?: InitPlan
	diagnostics: Diagnostic[]
}

/** Create a new complete Spec workspace without consulting Git or EF storage. */
export async function initWorkspace(root: string, values: InitValues = {}): Promise<InitWorkspaceResult> {
	const projectRoot = resolve(root)
	const specPath = join(projectRoot, SPEC_ROOT)
	const suppliedTitle = values.title?.trim()
	if (suppliedTitle && /[\r\n]/.test(suppliedTitle))
		return { ok: false, diagnostics: [diagnostic('SPEC-ENVELOPE-INVALID', 'Project title must be a non-empty single-line string.', { field: 'title' })] }
	try {
		await lstat(specPath)
		return { ok: false, diagnostics: [diagnostic('SPEC-LAYOUT-INVALID', `A Spec workspace entry already exists at '${SPEC_ROOT}'.`, { path: SPEC_ROOT })] }
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			return { ok: false, diagnostics: [diagnostic('SPEC-IO-ERROR', `Could not inspect '${SPEC_ROOT}': ${(error as Error).message}.`, { path: SPEC_ROOT })] }
		// The expected first-init case: `.spec/` does not exist yet.
	}
	const plan = computeInitPlan(projectRoot, values)
	const temporarySpecPath = join(projectRoot, `.spec-init-${randomUUID()}.tmp`)
	try {
		await mkdir(projectRoot, { recursive: true })
		await mkdir(temporarySpecPath, { recursive: false })
		for (const directory of Object.values(PLURAL_DIRECTORY_BY_KIND))
			await mkdir(join(temporarySpecPath, directory), { recursive: false })
		await mkdir(join(temporarySpecPath, 'resources'), { recursive: false })
		await writeFile(join(temporarySpecPath, 'config.yaml'), plan.files[0]!.content, { encoding: 'utf8', flag: 'wx' })
		await writeFile(join(temporarySpecPath, plan.files[1]!.path.slice(`${SPEC_ROOT}/`.length)), plan.files[1]!.content, { encoding: 'utf8', flag: 'wx' })
		await rename(temporarySpecPath, specPath)
		return { ok: true, plan, diagnostics: [] }
	}
	catch (error) {
		return { ok: false, diagnostics: [diagnostic('SPEC-IO-ERROR', `Could not initialize '${SPEC_ROOT}/': ${(error as Error).message}.`, { path: SPEC_ROOT })] }
	}
	finally {
		await rm(temporarySpecPath, { recursive: true, force: true })
			.catch(() => undefined)
	}
}

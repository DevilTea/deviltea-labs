import type { ArtifactKind } from '../domain/model'
import { isUuidV7 } from '../domain/identity'
import { PLURAL_DIRECTORY_BY_KIND } from '../domain/model'

export const SPEC_ROOT = '.spec'
export const RESOURCE_ROOT = `${SPEC_ROOT}/resources`

export const CANONICAL_DIRECTORY_BY_KIND: Record<ArtifactKind, string> = Object.fromEntries(
	(Object.entries(PLURAL_DIRECTORY_BY_KIND) as [ArtifactKind, string][]).map(([kind, directory]) => [kind, `${SPEC_ROOT}/${directory}`]),
) as Record<ArtifactKind, string>

export function canonicalArtifactPath(kind: ArtifactKind, id: string): string {
	return `${CANONICAL_DIRECTORY_BY_KIND[kind]}/${id}.md`
}

export function canonicalResourceOwnerPath(ownerId: string): string {
	return `${RESOURCE_ROOT}/${ownerId}`
}

export interface ParsedArtifactPath {
	directory: string
	id: string
}

/** Parse only the canonical project-relative path shape; kind is resolved separately. */
export function parseArtifactPath(relativePath: string): ParsedArtifactPath | undefined {
	const match = /^(\.spec\/[a-z-]+)\/([^/]+)\.md$/.exec(relativePath)
	if (!match || !isUuidV7(match[2]))
		return undefined
	return { directory: match[1]!, id: match[2]! }
}

export function expectedDirectory(kind: ArtifactKind): string {
	return CANONICAL_DIRECTORY_BY_KIND[kind]
}

export function isCanonicalArtifactPath(relativePath: string, kind: ArtifactKind, id: string): boolean {
	return relativePath === canonicalArtifactPath(kind, id)
}

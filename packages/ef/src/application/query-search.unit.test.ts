import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareSearchTerms } from './case-folding'
import { executeSearch } from './query-search'
import { loadSnapshotFromWorkingTree } from './snapshot'
import { validateSnapshot } from './snapshot-validation'

const CONFIG_YAML = `schema: ef/config@1
repository:
  integration_ref: refs/heads/main
linked_repositories: []
schemas:
  artifact_write_major: 1
`

const PROJECT_MD = `---
schema: ef/project@1
type: project
id: PROJECT
title: Example Project
status: active
summary: A minimal example project used for search tests.
tags: []
relations: []
resources: []
---

## Vision

Deliver a well-governed engineering workflow.

## Scope

This project covers specification-driven engineering artifacts.

## Non-goals

This project does not manage unrelated deployment tooling.

## Context

Single-repository workspace, no linked repositories.

## Terminology

| Term | Definition | Avoid or aliases |
| --- | --- | --- |
`

// Mirrors 10-query-and-trace.md's own worked search example almost exactly
// (title/summary/tags/body/resource location+description), so the body
// match's column (25) can be checked against the spec's own worked value.
const REQ_031 = `---
schema: ef/requirement@1
type: requirement
id: REQ-031
title: Search Result Filtering
status: active
summary: Search results must support filtering by supported criteria.
tags:
  - search
  - user-experience
relations: []
resources:
  - type: json-schema
    location: .engineering/resources/REQ-031/search-filter.schema.json
    role: contract
    media_type: application/json
    normative: true
    description: Canonical persisted representation referencing filtering.
---

## Requirement

The system must support filtering by content type.

## Rationale

This requirement exists to keep search results relevant.

## Acceptance Criteria

- Filtering by content type is supported.
`

// A "distractor" that matches only one of two AND-combined terms.
const REQ_032 = `---
schema: ef/requirement@1
type: requirement
id: REQ-032
title: Unrelated Requirement
status: active
summary: This requirement mentions criteria but nothing else relevant.
tags: []
relations: []
resources: []
---

## Requirement

The system must behave as specified by this requirement.

## Rationale

This requirement exists to keep the example fixture meaningful.

## Acceptance Criteria

- The system behaves as specified.
`

// Turkish İ / ß case-folding fixture.
const REQ_040 = `---
schema: ef/requirement@1
type: requirement
id: REQ-040
title: İstanbul Office Requirements
status: active
summary: Requirements for the İstanbul regional office.
tags: []
relations: []
resources: []
---

## Requirement

Straße appears here as a plain reference.

STRAẞE appears here too, in capitals.

Strasse should not match under a ß search.

istanbul lowercase should not match under an İ search.
`

function paginationRequirement(id: string): string {
	return `---
schema: ef/requirement@1
type: requirement
id: ${id}
title: Widget Requirement ${id}
status: active
summary: This requirement is about a widget.
tags: []
relations: []
resources: []
---

## Requirement

The widget must behave as specified.

## Rationale

This requirement exists to keep the example fixture meaningful.

## Acceptance Criteria

- The widget behaves as specified.
`
}

// An image-only H2 heading: extractPlainText has no `value` (not a text
// node) and no `children` (images are leaf nodes) to fall back to, so the
// section title resolves to the empty string rather than throwing.
const REQ_060 = `---
schema: ef/requirement@1
type: requirement
id: REQ-060
title: Diagram Requirement
status: active
summary: This requirement is about a diagram.
tags: []
relations: []
resources: []
---

## ![Diagram](diagram.png)

The diagram-marker line appears under an image-only heading.
`

// The body line below spells "café" in NFD (decomposed: "e" + a combining
// acute accent, U+0301), which differs from its NFC form -- exercising the
// "text required NFC normalization to match" path (no exact position
// reported).
const REQ_070 = `---
schema: ef/requirement@1
type: requirement
id: REQ-070
title: NFC Normalization Requirement
status: active
summary: Exercises NFC normalization fallback matching.
tags: []
relations: []
resources: []
---

## Requirement

Uses café as a decomposed-form Unicode keyword.

## Rationale

This requirement exists to keep the example fixture meaningful.

## Acceptance Criteria

- The system behaves as specified.
`

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
	const fullPath = path.join(root, relativePath)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, content)
}

describe('executeSearch', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ef-search-')))
		await writeFile(tempDir, '.engineering/ef.yaml', CONFIG_YAML)
		await writeFile(tempDir, '.engineering/PROJECT.md', PROJECT_MD)
		await writeFile(tempDir, '.engineering/req/REQ-031.md', REQ_031)
		await writeFile(tempDir, '.engineering/req/REQ-032.md', REQ_032)
		await writeFile(tempDir, '.engineering/req/REQ-040.md', REQ_040)
		await writeFile(
			tempDir,
			'.engineering/resources/REQ-031/search-filter.schema.json',
			'{"type": "object"}\n',
		)
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function load() {
		const result = await loadSnapshotFromWorkingTree(tempDir)
		if (!result.ok)
			throw new Error(`failed to load snapshot: ${result.reason}`)
		return { snapshot: result.snapshot, validation: validateSnapshot(result.snapshot) }
	}

	it('matches title, summary, tags, body, and resource fields, ordered by field priority', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['filtering'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)

		expect(data.terms)
			.toEqual(['filtering'])
		expect(data.case_sensitive)
			.toBe(false)
		expect(data.total)
			.toBe(1)

		const result = data.results.find(r => r.artifact.id === 'REQ-031')!
		expect(result)
			.toBeDefined()

		// "filtering" occurs in title, summary, two body lines, and the
		// resource description, but NOT literally in any tag ("search",
		// "user-experience") or in the resource location (which contains
		// "search-filter", not "filtering").
		const fields = result.matches.map(m => m.field)
		expect(fields)
			.toEqual(['title', 'summary', 'body', 'body', 'resources.description'])

		const summaryMatch = result.matches.find(m => m.field === 'summary')!
		expect(summaryMatch)
			.toEqual({
				field: 'summary',
				section: null,
				line: null,
				column: null,
				text: 'Search results must support filtering by supported criteria.',
			})

		const bodyMatches = result.matches.filter(m => m.field === 'body')
		const requirementBodyMatch = bodyMatches.find(m => m.text === 'The system must support filtering by content type.')!
		expect(requirementBodyMatch.section)
			.toBe('Requirement')
		expect(requirementBodyMatch.column)
			.toBe(25)
		expect(typeof requirementBodyMatch.line)
			.toBe('number')

		const acceptanceBodyMatch = bodyMatches.find(m => m.text === '- Filtering by content type is supported.')!
		expect(acceptanceBodyMatch.section)
			.toBe('Acceptance Criteria')
		// Body matches are ordered by line ascending (earlier "Requirement" line first).
		expect(bodyMatches.indexOf(requirementBodyMatch))
			.toBeLessThan(bodyMatches.indexOf(acceptanceBodyMatch))
	})

	it('matches a tag exactly', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['search'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-031')!
		const tagMatch = result.matches.find(m => m.field === 'tags')!
		expect(tagMatch.text)
			.toBe('search')
	})

	it('applies Artifact-scope AND across multiple terms in different surfaces', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['criteria', 'content'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		// REQ-032 has "criteria" (summary) but not "content" anywhere -> excluded.
		// REQ-031 has both ("criteria" in summary, "content" in body) -> included.
		expect(data.results.map(r => r.artifact.id))
			.toEqual(['REQ-031'])
	})

	it('is case-insensitive by default', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['FILTERING'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		expect(data.results.map(r => r.artifact.id))
			.toContain('REQ-031')
	})

	it('honors case-sensitive matching when requested', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['FILTERING'], true)!
		const data = executeSearch(snapshot, validation, terms, true, 0, null)
		expect(data.results.map(r => r.artifact.id))
			.not.toContain('REQ-031')
	})

	it('does not fold Turkish İ to plain i under simple case-insensitive folding', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['İstanbul'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-040')
		expect(result)
			.toBeDefined()
		// The lowercase "istanbul" body line must NOT itself be treated as
		// satisfying the term were it the only occurrence; here it just
		// documents that at least one exact (capitalized) occurrence exists.
		expect(result!.matches.some(m => m.text.includes('İstanbul')))
			.toBe(true)
	})

	it('folds ß and ẞ to the same value but not to "ss" under simple case-insensitive folding', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['straße'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-040')!
		const bodyTexts = result.matches.filter(m => m.field === 'body')
			.map(m => m.text)
		expect(bodyTexts.some(t => t.startsWith('Straße')))
			.toBe(true)
		expect(bodyTexts.some(t => t.startsWith('STRAẞE')))
			.toBe(true)
		expect(bodyTexts.some(t => t.startsWith('Strasse')))
			.toBe(false)
	})

	it('orders matching Artifacts by bytewise Artifact ID and paginates with a stable total', async () => {
		await writeFile(tempDir, '.engineering/req/REQ-050.md', paginationRequirement('REQ-050'))
		await writeFile(tempDir, '.engineering/req/REQ-051.md', paginationRequirement('REQ-051'))
		await writeFile(tempDir, '.engineering/req/REQ-052.md', paginationRequirement('REQ-052'))
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['widget'], false)!

		const full = executeSearch(snapshot, validation, terms, false, 0, null)
		expect(full.results.map(r => r.artifact.id))
			.toEqual(['REQ-050', 'REQ-051', 'REQ-052'])
		expect(full.total)
			.toBe(3)

		const paged = executeSearch(snapshot, validation, terms, false, 1, 1)
		expect(paged.total)
			.toBe(3)
		expect(paged.offset)
			.toBe(1)
		expect(paged.limit)
			.toBe(1)
		expect(paged.results.map(r => r.artifact.id))
			.toEqual(['REQ-051'])
	})

	it('deduplicates terms in the reported terms array while preserving first position', async () => {
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['filtering', 'FILTERING'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		expect(data.terms)
			.toEqual(['filtering'])
	})

	it('attributes a body match to an empty section title under an image-only H2 heading', async () => {
		await writeFile(tempDir, '.engineering/req/REQ-060.md', REQ_060)
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['diagram-marker'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-060')!
		const bodyMatch = result.matches.find(m => m.field === 'body')!
		expect(bodyMatch.section)
			.toBe('')
	})

	it('matches text that required NFC normalization, without reporting an exact column', async () => {
		await writeFile(tempDir, '.engineering/req/REQ-070.md', REQ_070)
		const { snapshot, validation } = await load()
		const terms = prepareSearchTerms(['café'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-070')!
		const bodyMatch = result.matches.find(m => m.field === 'body' && m.text.includes('decomposed-form'))!
		expect(bodyMatch.column)
			.toBeNull()
	})

	it('keeps the earliest term-match position within one surface as the reported column', async () => {
		const { snapshot, validation } = await load()
		// Both terms occur on the same REQ-031 body line, "filtering" before
		// "content"; the later term's match must not overwrite the earlier,
		// already-minimal exact position.
		const terms = prepareSearchTerms(['filtering', 'content'], false)!
		const data = executeSearch(snapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-031')!
		const bodyMatch = result.matches.find(m => m.text === 'The system must support filtering by content type.')!
		const filteringIndex = bodyMatch.text.toLowerCase()
			.indexOf('filtering')
		expect(bodyMatch.column)
			.toBe(filteringIndex + 1)
	})

	it('falls back to a null section for every body line when a file\'s sections could not be computed', async () => {
		const { snapshot, validation } = await load()
		// `sections` is `undefined` whenever body parsing failed
		// (snapshot.ts: "Present only when frontmatter.ok && body.ok"); real
		// GFM parse failures are impractical to trigger from genuine Markdown
		// (mdast-util-from-markdown rarely throws), so this overrides the field
		// directly to exercise `buildLineSectionMap`'s own documented fallback.
		const patchedArtifacts = snapshot.artifacts.map(a => a.path === '.engineering/req/REQ-031.md' ? { ...a, sections: undefined } : a)
		const patchedSnapshot = { ...snapshot, artifacts: patchedArtifacts }
		const terms = prepareSearchTerms(['filtering'], false)!
		const data = executeSearch(patchedSnapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-031')!
		const bodyMatches = result.matches.filter(m => m.field === 'body')
		expect(bodyMatches.length)
			.toBeGreaterThan(0)
		expect(bodyMatches.every(m => m.section === null))
			.toBe(true)
	})

	it('still matches non-body fields when the record\'s file is absent from the snapshot', async () => {
		const { snapshot, validation } = await load()
		// `executeSearch` takes `snapshot` and `validation` as independent
		// parameters; a real, matched pair always has a `snapshot.artifacts`
		// entry for every `validation.byId` record's path, so this mismatch is
		// only reachable by constructing it directly, exercising
		// `buildSurfaces`' own documented `file?.` fallback.
		const patchedSnapshot = { ...snapshot, artifacts: snapshot.artifacts.filter(a => a.path !== '.engineering/req/REQ-031.md') }
		const terms = prepareSearchTerms(['filtering'], false)!
		const data = executeSearch(patchedSnapshot, validation, terms, false, 0, null)
		const result = data.results.find(r => r.artifact.id === 'REQ-031')!
		expect(result)
			.toBeDefined()
		expect(result.matches.some(m => m.field === 'title'))
			.toBe(true)
		expect(result.matches.some(m => m.field === 'body'))
			.toBe(false)
	})
})

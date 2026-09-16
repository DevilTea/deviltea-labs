export interface BodySection {
	heading: string
	line: number
	content: string
}

function cleanHeading(value: string): string {
	return value.trim()
		.replace(/[ \t]+#+[ \t]*$/, '')
		.trim()
}

/** Extract top-level H2 sections while ignoring headings inside fenced code. */
export function extractSections(body: string): BodySection[] {
	const sections: BodySection[] = []
	const lines = body.split(/\r\n|\r|\n/)
	let current: BodySection | undefined
	let fenced = false
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? ''
		if (/^\s*(?:```|~~~)/.test(line)) {
			fenced = !fenced
			if (current)
				current.content += `${line}\n`
			continue
		}
		const isH2 = !fenced && line.startsWith('##') && line[2] !== '#' && (line[2] === ' ' || line[2] === '\t')
		if (isH2) {
			const heading = cleanHeading(line.slice(3)
				.trimEnd())
			if (heading === '')
				continue
			current = { heading, line: index + 1, content: '' }
			sections.push(current)
			continue
		}
		if (current)
			current.content += `${line}\n`
	}
	return sections
}

function withoutComments(value: string): string {
	return value.replace(/<!--[\s\S]*?-->/g, '')
}

function isHeadingLine(line: string): boolean {
	const text = line.trimStart()
	let count = 0
	while (text[count] === '#')
		count++
	return count > 0 && count <= 6 && (text.length === count || text[count] === ' ' || text[count] === '\t')
}

function contentLines(value: string): { lines: string[], hasCode: boolean } {
	const lines: string[] = []
	let hasCode = false
	let fenced = false
	for (const rawLine of withoutComments(value)
		.split(/\r\n|\r|\n/)) {
		if (/^\s*(?:```|~~~)/.test(rawLine)) {
			fenced = !fenced
			continue
		}
		if (rawLine.trim() === '' || isHeadingLine(rawLine))
			continue
		if (fenced)
			hasCode = true
		lines.push(rawLine)
	}
	return { lines, hasCode }
}

export function isMeaningful(value: string): boolean {
	return contentLines(value).lines.length > 0
}

export function isPlaceholderOnly(value: string): boolean {
	const content = contentLines(value)
	if (content.hasCode)
		return false
	const text = content.lines.join(' ')
		.replace(/[`*_#>\-[\]().,:;!?]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLocaleLowerCase('en-US')
	return /^(?:todo|tbd|lorem ipsum)$/.test(text)
}

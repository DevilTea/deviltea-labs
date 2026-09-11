import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_CODES, severityOf } from './diagnostic-codes'
import { extractDiagnosticRows, ownerFileOf, parseReservedSlots } from './diagnostic-docs-parser'

// docs/ef-core lives two levels up from src/domain/.
const DOCS_DIR = fileURLToPath(new URL('../../docs/ef-core', import.meta.url))

function readDoc(fileName: string): string {
	return fs.readFileSync(path.join(DOCS_DIR, fileName), 'utf8')
}

/** All `docs/ef-core/NN-*.md` numbered specification files, sorted for deterministic error output. */
function listOwningSpecFileNames(): string[] {
	return fs.readdirSync(DOCS_DIR)
		.filter(name => /^\d\d-.*\.md$/.test(name))
		.sort()
}

const registryText = readDoc('diagnostic-registry.md')
const registryRows = extractDiagnosticRows(registryText)
const registryByCode = new Map(registryRows.map(row => [row.code, row]))
const reservedSlots = parseReservedSlots(registryText)

/**
 * Aggregates the diagnostic tables embedded in each owning specification
 * (per the registry's maintenance rule: "Add a code first to its owning
 * specification table, then regenerate this registry."). Fails loudly if
 * the same code is defined in two different owning specs, since that is a
 * documentation bug the comparison below cannot otherwise surface.
 */
function collectOwningSpecRows(): { byCode: Map<string, { row: ReturnType<typeof extractDiagnosticRows>[number], file: string }>, duplicates: string[] } {
	const byCode = new Map<string, { row: ReturnType<typeof extractDiagnosticRows>[number], file: string }>()
	const duplicates: string[] = []
	for (const file of listOwningSpecFileNames()) {
		const rows = extractDiagnosticRows(readDoc(file))
		for (const row of rows) {
			const existing = byCode.get(row.code)
			if (existing) {
				duplicates.push(`${row.code} (in both ${existing.file} and ${file})`)
				continue
			}
			byCode.set(row.code, { row, file })
		}
	}
	return { byCode, duplicates }
}

describe('dIAGNOSTIC_CODES structural parity with docs/ef-core/diagnostic-registry.md', () => {
	it('has exactly the codes listed in the registry\'s Codes table, with matching severities on both sides', () => {
		const implCodes = new Set(Object.keys(DIAGNOSTIC_CODES))
		const registryCodes = new Set(registryByCode.keys())

		const missingFromImpl = [...registryCodes].filter(code => !implCodes.has(code))
			.sort()
		const missingFromRegistry = [...implCodes].filter(code => !registryCodes.has(code))
			.sort()
		const severityMismatches = [...registryCodes]
			.filter(code => implCodes.has(code))
			.map((code) => {
				const registrySeverity = registryByCode.get(code)!.severity
				const implSeverity = DIAGNOSTIC_CODES[code as keyof typeof DIAGNOSTIC_CODES]
				return { code, registrySeverity, implSeverity }
			})
			.filter(({ registrySeverity, implSeverity }) => registrySeverity !== implSeverity)

		expect(missingFromImpl, `codes in diagnostic-registry.md's Codes table but missing from DIAGNOSTIC_CODES: ${missingFromImpl.join(', ') || 'none'}`)
			.toEqual([])
		expect(missingFromRegistry, `codes in DIAGNOSTIC_CODES but missing from diagnostic-registry.md's Codes table: ${missingFromRegistry.join(', ') || 'none'}`)
			.toEqual([])
		expect(severityMismatches, `severity disagrees between registry and DIAGNOSTIC_CODES for: ${severityMismatches.map(m => `${m.code} (registry=${m.registrySeverity}, impl=${m.implSeverity})`)
			.join(', ') || 'none'}`)
			.toEqual([])
	})

	it('omits every code the registry marks reserved, and no reserved code doubles as an active code in the registry itself', () => {
		const implCodes = new Set(Object.keys(DIAGNOSTIC_CODES))
		const registryCodes = new Set(registryByCode.keys())

		const reservedButImplemented = [...reservedSlots].filter(code => implCodes.has(code))
			.sort()
		const reservedButActiveInRegistry = [...reservedSlots].filter(code => registryCodes.has(code))
			.sort()

		expect(reservedButImplemented, `codes reserved in diagnostic-registry.md but still assigned in DIAGNOSTIC_CODES: ${reservedButImplemented.join(', ') || 'none'}`)
			.toEqual([])
		expect(reservedButActiveInRegistry, `codes reserved in diagnostic-registry.md's Reserved numeric slots section but also present in its own Codes table: ${reservedButActiveInRegistry.join(', ') || 'none'}`)
			.toEqual([])
	})
})

describe('diagnostic-registry.md structural parity with each owning specification\'s own diagnostic table', () => {
	// The registry's maintenance rule requires a code to exist first in its
	// owning spec's embedded table, then be mirrored into the registry. This
	// check parses BOTH sides from docs/ef-core/*.md and compares them
	// directly, independent of DIAGNOSTIC_CODES, so that editing the registry
	// and an owning spec in lockstep (without touching the implementation)
	// still gets caught.
	//
	// Compared: code, severity, and condition text with internal whitespace
	// collapsed (Markdown line-wrapping can introduce incidental extra
	// spaces without changing meaning). NOT compared: case, punctuation, or
	// any other column (Scope, Exit treatment/class, Owner) -- those are
	// either registry-only bookkeeping or already covered by the ownerFileOf
	// check below.
	const { byCode: specByCode, duplicates } = collectOwningSpecRows()

	it('defines no diagnostic code in more than one owning specification', () => {
		expect(duplicates, `codes defined in more than one owning spec table: ${duplicates.join('; ') || 'none'}`)
			.toEqual([])
	})

	it('has exactly the codes present in the union of owning specs\' diagnostic tables', () => {
		const registryCodes = new Set(registryByCode.keys())
		const specCodes = new Set(specByCode.keys())

		const missingFromSpecs = [...registryCodes].filter(code => !specCodes.has(code))
			.sort()
		const missingFromRegistry = [...specCodes].filter(code => !registryCodes.has(code))
			.sort()

		expect(missingFromSpecs, `codes in diagnostic-registry.md but absent from every owning spec's own diagnostic table: ${missingFromSpecs.join(', ') || 'none'}`)
			.toEqual([])
		expect(missingFromRegistry, `codes in an owning spec's diagnostic table but absent from diagnostic-registry.md: ${missingFromRegistry.join(', ') || 'none'}`)
			.toEqual([])
	})

	it('agrees with each owning spec\'s table on severity for every shared code', () => {
		const sharedCodes = [...registryByCode.keys()].filter(code => specByCode.has(code))
		const mismatches = sharedCodes
			.map((code) => {
				const registryRow = registryByCode.get(code)!
				const specEntry = specByCode.get(code)!
				return { code, file: specEntry.file, registrySeverity: registryRow.severity, specSeverity: specEntry.row.severity }
			})
			.filter(m => m.registrySeverity !== m.specSeverity)

		expect(mismatches, `severity disagrees between the registry and the owning spec for: ${mismatches.map(m => `${m.code} (registry=${m.registrySeverity}, ${m.file}=${m.specSeverity})`)
			.join(', ') || 'none'}`)
			.toEqual([])
	})

	it('agrees with each owning spec\'s table on condition text (whitespace-normalized) for every shared code', () => {
		const sharedCodes = [...registryByCode.keys()].filter(code => specByCode.has(code))
		const mismatches = sharedCodes
			.map((code) => {
				const registryRow = registryByCode.get(code)!
				const specEntry = specByCode.get(code)!
				return { code, file: specEntry.file, registryCondition: registryRow.condition, specCondition: specEntry.row.condition }
			})
			.filter(m => m.registryCondition !== m.specCondition)

		expect(mismatches, `condition text disagrees between the registry and the owning spec for: ${mismatches.map(m => `${m.code} (registry="${m.registryCondition}", ${m.file}="${m.specCondition}")`)
			.join('; ') || 'none'}`)
			.toEqual([])
	})

	it('names each code\'s owning spec file consistently with where that code is actually defined', () => {
		const mismatches = [...registryByCode.values()]
			.filter(row => specByCode.has(row.code))
			.map((row) => {
				const declaredOwner = ownerFileOf(row)
				const actualFile = specByCode.get(row.code)!.file
				return { code: row.code, declaredOwner, actualFile }
			})
			.filter(m => m.declaredOwner !== m.actualFile)

		expect(mismatches, `registry Owner column disagrees with the file that actually defines the code: ${mismatches.map(m => `${m.code} (Owner column says ${m.declaredOwner}, actually defined in ${m.actualFile})`)
			.join(', ') || 'none'}`)
			.toEqual([])
	})
})

describe('dIAGNOSTIC_CODES range-validation additions (EF-VAL-013, EF-VAL-014, reserved EF-VAL-003)', () => {
	it('registers EF-VAL-013 as an error', () => {
		expect(DIAGNOSTIC_CODES['EF-VAL-013'])
			.toBe('error')
	})

	it('registers EF-VAL-014 as an info diagnostic', () => {
		expect(DIAGNOSTIC_CODES['EF-VAL-014'])
			.toBe('info')
	})

	it('does not (re)assign the reserved EF-VAL-003 slot', () => {
		expect(Object.hasOwn(DIAGNOSTIC_CODES, 'EF-VAL-003'))
			.toBe(false)
	})
})

describe('severityOf', () => {
	it('returns the registered severity for the new range-validation codes', () => {
		expect(severityOf('EF-VAL-013'))
			.toBe('error')
		expect(severityOf('EF-VAL-014'))
			.toBe('info')
	})
})

import { writeFileSync } from 'node:fs'
import { toJsonSchema } from '@valibot/to-json-schema'
import { machineConfigShape } from '../src/definition'

writeFileSync(new URL('../schema.json', import.meta.url), `${JSON.stringify(toJsonSchema(machineConfigShape), null, '\t')}\n`)

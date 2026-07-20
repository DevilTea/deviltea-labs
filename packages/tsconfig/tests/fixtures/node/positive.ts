import { readFile } from 'node:fs/promises'
import process from 'node:process'

export const platform = process.platform
export const readText = (path: string): Promise<string> => readFile(path, 'utf8')

import { execFileSync } from 'node:child_process'
import process from 'node:process'

function manifest(path) {
	return JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }))
}

const [corePath, vuePath, ...extra] = process.argv.slice(2)
if (!corePath || !vuePath || extra.length)
	throw new Error('Expected one core and one Vue tarball.')
const core = manifest(corePath)
const vue = manifest(vuePath)
if (core.name !== '@deviltea/tiny-state-machine' || vue.name !== '@deviltea/tiny-state-machine-vue' || !core.version || core.version !== vue.version || vue.peerDependencies?.[core.name] !== core.version)
	throw new Error('Packed FSM versions and exact Vue core peer must match.')
console.log(`Verified packed FSM family at ${core.version}.`)

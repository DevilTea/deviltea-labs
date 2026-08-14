/**
 * Combined GitHub Pages build: docs/site + widget-lab sharing one artifact.
 *
 * Normative source: issue #13 Checkpoint A "Widget Lab" deployment section. `docs/site` and
 * `apps/widget-lab` stay separate source/application boundaries — this script only combines their
 * build output into the single directory the Pages workflow already uploads
 * (`docs/site/.vitepress/dist`):
 *
 *   1. build widget-lab AND its workspace dependencies (`@deviltea/widget-core`,
 *      `@deviltea/widget-vue`), in topological order, with WIDGET_LAB_BASE so widget-lab's own
 *      asset/worker URLs resolve under the deployed subpath (see apps/widget-lab/vite.config.ts).
 *      The Pages workflow runs only this script — not the root `pnpm build` — so this step cannot
 *      assume widget-core/widget-vue already have a `dist` (see issue #13 Pages-build-deps
 *      postmortem: CI failed with an unresolvable `@deviltea/widget-core/inspection` import because
 *      widget-lab was built alone, before its workspace deps had a `dist`). `widget-lab...` is a
 *      pnpm filter that selects the package and everything it depends on; WIDGET_LAB_BASE is
 *      harmless for widget-core/widget-vue's own `tsdown` builds, which never read it.
 *   2. build docs/site — vitepress empties its own `dist` on every build, so this must run before
 *      the copy below, not after;
 *   3. copy widget-lab's build output beneath `dist/widget-lab/`.
 */

import { cp, rm } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { $ } from 'zx'

const WIDGET_LAB_BASE = '/deviltea-labs/widget-lab/'

const root = fileURLToPath(new URL('..', import.meta.url))
const widgetLabDist = join(root, 'apps/widget-lab/dist')
const docsDist = join(root, 'docs/site/.vitepress/dist')
const widgetLabTarget = join(docsDist, 'widget-lab')

$.cwd = root
$.verbose = true

await $({
	env: { ...process.env, WIDGET_LAB_BASE },
})`pnpm --filter widget-lab... run build`

await $`pnpm --filter docs run build`

await rm(widgetLabTarget, { recursive: true, force: true })
await cp(widgetLabDist, widgetLabTarget, { recursive: true })

console.log(`Combined Pages artifact ready at ${docsDist} (widget-lab under widget-lab/, base ${WIDGET_LAB_BASE})`)

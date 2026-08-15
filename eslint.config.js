// @ts-check
import deviltea from '@deviltea/eslint-config'

export default deviltea({
	ignores: [
		'**/dist/**',
		'**/.vitepress/cache/**',
		'**/.vitepress/dist/**',
		'packages/ef/docs/**/*.md/**',
		// `@pikacss/unplugin-pikacss` build-time codegen (see apps/widget-lab/pika.config.ts /
		// scripts/pika-codegen.mjs): regenerated on every dev/build/typecheck run, gitignored, and not
		// hand-authored source — same treatment as `dist/**` above.
		'**/pika.gen.*',
		// Playwright's own generated failure diagnostics/report output (issue #28 browser contract
		// suite) — gitignored (apps/widget-lab/.gitignore), not hand-authored source.
		'**/test-results/**',
		'**/playwright-report/**',
	],
}, {
	files: ['packages/*/package.json', 'packages/widget/*/package.json'],
	rules: {
		'pnpm/json-enforce-catalog': 'off',
	},
})

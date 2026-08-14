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
	],
}, {
	files: ['packages/*/package.json', 'packages/widget/*/package.json'],
	rules: {
		'pnpm/json-enforce-catalog': 'off',
	},
})

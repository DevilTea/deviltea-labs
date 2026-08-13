// @ts-check
import deviltea from '@deviltea/eslint-config'

export default deviltea({
	ignores: [
		'**/dist/**',
		'**/.vitepress/cache/**',
		'**/.vitepress/dist/**',
		'packages/ef/docs/**/*.md/**',
	],
}, {
	files: ['packages/*/package.json', 'packages/widget/*/package.json'],
	rules: {
		'pnpm/json-enforce-catalog': 'off',
	},
})

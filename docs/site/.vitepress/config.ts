import { defineConfig } from 'vitepress'

export default defineConfig({
	base: '/deviltea-labs/',
	title: 'DevilTea Labs',
	description: 'Documentation for maintained DevilTea packages.',
	// The Widget Lab (apps/widget-lab) is copied under dist/widget-lab/ by `docs:build:pages`
	// (issue #13 Checkpoint A "Widget Lab" deployment section) rather than being a VitePress page,
	// so the dead-link checker cannot resolve links to it.
	ignoreDeadLinks: [/^\/widget-lab\//],
	themeConfig: {
		nav: [
			{ text: 'Packages', link: '/packages/' },
		],
		sidebar: {
			'/packages/': [
				{
					text: 'Packages',
					items: [
						{ text: '@deviltea/eslint-config', link: '/packages/eslint-config' },
						{ text: '@deviltea/tsconfig', link: '/packages/tsconfig' },
						{ text: '@deviltea/vue-router-middleware', link: '/packages/vue-router-middleware' },
						{ text: 'vue-temp-var', link: '/packages/vue-temp-var' },
						{ text: '@deviltea/tiny-state-machine', link: '/packages/tiny-state-machine' },
						{ text: '@deviltea/tiny-state-machine-vue', link: '/packages/tiny-state-machine-vue' },
						{ text: '@deviltea/ef', link: '/packages/ef' },
						{ text: '@deviltea/widget-core', link: '/packages/widget-core' },
						{ text: '@deviltea/widget-vue', link: '/packages/widget-vue' },
					],
				},
			],
		},
		socialLinks: [
			{ icon: 'github', link: 'https://github.com/DevilTea/deviltea-labs' },
		],
		footer: {
			message: 'Released under the MIT License.',
			copyright: 'Copyright © 2023-PRESENT DevilTea',
		},
	},
})

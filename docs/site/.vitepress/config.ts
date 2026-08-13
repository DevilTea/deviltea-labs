import { defineConfig } from 'vitepress'

export default defineConfig({
	base: '/deviltea-labs/',
	title: 'DevilTea Labs',
	description: 'Documentation for maintained DevilTea packages.',
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

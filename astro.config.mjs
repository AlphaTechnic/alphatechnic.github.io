import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import tailwindcss from '@tailwindcss/vite'
import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import icon from 'astro-icon'
import rehypeFigureTitle from 'rehype-figure-title'
import { rehypeAccessibleEmojis } from 'rehype-accessible-emojis'
import { remarkReadingTime } from './src/plugins/remark-reading-time.mjs'

// https://astro.build/config
export default defineConfig({
	site: 'https://alphatechnic.github.io',
	integrations: [mdx(), sitemap(), icon()],
	markdown: {
		processor: unified({
			remarkPlugins: [remarkReadingTime],
			rehypePlugins: [rehypeFigureTitle, rehypeAccessibleEmojis],
		}),
	},
	vite: {
		plugins: [tailwindcss()],
	},
})

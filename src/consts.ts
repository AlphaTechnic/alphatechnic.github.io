// Global site settings. Change these first when renaming or moving the blog.

export const SITE_TITLE = 'AlphaTechnic Tech Blog'
export const SITE_HEADING = "AlphaTechnic's Blog"
export const SITE_DESCRIPTION =
	'Backend developer using Scala and ZIO with a functional programming approach.'

// Set to '/repo-name' (and `base` in astro.config.mjs) only when deploying to
// a project page such as user.github.io/repo-name. Empty for a root domain.
export const SITE_BASE = ''

export const SocialLinks = [
	{
		name: 'GitHub',
		url: 'https://github.com/AlphaTechnic',
	},
]

// `url` is either a site path ('/', '/about') or an absolute URL.
export const WebsiteLinks = [
	{
		name: 'Blog',
		url: '/',
	},
	{
		name: 'Projects',
		url: 'https://github.com/AlphaTechnic?tab=repositories',
	},
]

export const isExternal = (url: string) => /^https?:\/\//.test(url)
export const resolveUrl = (url: string) =>
	isExternal(url) ? url : `${SITE_BASE}${url}`

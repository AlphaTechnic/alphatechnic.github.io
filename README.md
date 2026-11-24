# AlphaTechnic Tech Blog

Astro blog based on the [Saral](https://github.com/yashjawale/saral-theme-astro) theme (MIT, see `THEME_LICENSE`), deployed to GitHub Pages.

## Commands

| Command           | Action                                   |
| ----------------- | ---------------------------------------- |
| `npm install`     | Install dependencies                     |
| `npm run dev`     | Local preview at `http://localhost:4321` |
| `npm run build`   | Type-check and build into `dist/`        |
| `npm run preview` | Serve the built site                     |

## Writing a post

1. Create `src/content/blog/<slug>.md`. The file name becomes the URL: `/<slug>/`.
2. Start it with front matter, and use `##` / `###` for sections (they feed the table of contents):

   ```md
   ---
   title: 'Post title'
   description: 'One or two sentences shown on the card and in search results.'
   pubDate: 2026-11-25
   tags: ['scala', 'zio']
   ---
   ```

3. Optional cover: `src/assets/blogimages/<slug>/cover.jpg` (853x480).
4. Other images: put them in the same folder and use `![alt](../../assets/blogimages/<slug>/name.png)`.
5. Push to `main`; GitHub Actions builds and deploys.

Site title, navigation and social links live in `src/consts.ts`; the site URL is in `astro.config.mjs`.

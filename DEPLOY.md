# Deploying the demo

The live demo is hosted on **GitHub Pages** at
https://shyamvalsan.github.io/ramayana-rts/ and served from the **`gh-pages`
branch** (a prebuilt copy of `dist/`).

## Redeploy (current method — branch deploy)

Any collaborator with push access can redeploy:

```bash
GITHUB_PAGES=1 npm run build     # builds dist/ with the /ramayana-rts/ base
touch dist/.nojekyll             # let Pages serve the assets/ folder as-is

# publish dist/ to the gh-pages branch
cd dist
git init -q && git checkout -q -b gh-pages
git add -A && git commit -q -m "Deploy"
git push -f https://github.com/shyamvalsan/ramayana-rts.git gh-pages
```

Pages is already configured (source: `gh-pages`, path `/`); the new commit goes
live within a minute.

## Optional: automatic CI deploys (GitHub Actions)

A ready-to-use workflow lives at
[`.github/deploy-pages-workflow.yml.example`](.github/deploy-pages-workflow.yml.example).
It builds with `GITHUB_PAGES=1` and deploys on every push to `main`. It was not
committed under `.github/workflows/` because the token used for the initial
push lacked the `workflow` OAuth scope. To enable it:

```bash
gh auth refresh -h github.com -s workflow     # one-time, grants the scope
mkdir -p .github/workflows
git mv .github/deploy-pages-workflow.yml.example .github/workflows/deploy.yml
git commit -m "Enable Pages CI deploy" && git push
```

Then, in the repo's **Settings → Pages**, set the source to **GitHub Actions**.
After that, pushing to `main` redeploys automatically and the manual
`gh-pages` steps above are no longer needed.

## Notes

- The build sets Vite's `base` to `/ramayana-rts/` only when `GITHUB_PAGES` is
  set (see `vite.config.ts`); local `npm run dev` / `npm run build` stay at `/`.
- First load streams ~45 MB of art; sprites fade in over a few seconds while
  they download, then the game is fully cached. Reducing that further (lazy
  loading non-critical sprites, or WebP) is a good future optimization.

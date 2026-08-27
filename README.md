# jameshih.github.io

Static source for `https://shih.app/`. The root page plays a mandatory 6.8-second cinematic intro and then hands off to `/blog/about`.

```sh
npm ci
npm run typecheck
npm run build
npm test
```

GitHub Pages serves the committed files in `assets/generated/`; CI rebuilds them and fails if they are stale.

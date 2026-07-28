# Publishing `omegas-dev`

GitHub Actions has been removed, so the `Publish omegas-dev` workflow is gone. It was
manual-trigger only, so nothing published automatically before either — but the steps it ran
are recorded here so the path is not lost.

From `packages/omegas-dev-cli`:

```bash
npm test
npm run check
# publish only if this version is not already on the registry
VERSION=$(node --print "require('./package.json').version")
npm view "omegas-dev@$VERSION" version >/dev/null 2>&1 \
  && echo "omegas-dev@$VERSION already published" \
  || npm publish
```

Requires an npm auth token with publish rights for the package.

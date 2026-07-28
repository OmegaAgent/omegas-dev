# Publishing `omegas-dev`

Publishing is intentionally manual. A release must correspond to a reviewed commit and tag in
this public repository.

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

Requires npm publish rights for the package. After publishing, verify the npm metadata points to
this repository and that the packed files match the tagged source.

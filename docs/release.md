# Release

Diffwarden publishes source releases on GitHub and the installable CLI package on npm.

## One-Time npm Setup

The package is published as `diffwarden` on npm. To let GitHub Actions publish future
versions without a long-lived npm token, configure a trusted publisher on npmjs.com:

- Provider: GitHub Actions
- Organization or user: `aurokin`
- Repository: `diffwarden`
- Workflow filename: `npm-publish.yml`
- Allowed action: `npm publish`

The workflow file must live at `.github/workflows/npm-publish.yml`; npm asks for the
filename only, not the full path. npm trusted publishing requires GitHub-hosted runners,
an OIDC token permission, npm CLI `>=11.5.1`, and Node `>=22.14.0`. The workflow uses
Node 24 and updates npm before publishing.

## Release Steps

1. Bump `package.json` and `src/version.ts` to the same version.
2. Run the local gate:

   ```bash
   pnpm check
   npm pack --dry-run
   ```

3. Commit and push the release prep.
4. Create and push an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. Create the GitHub Release from that tag. Publishing the release triggers
   `.github/workflows/npm-publish.yml`, which runs the gate again and publishes to npm.

If trusted publishing has not been configured yet, publish manually with an npm account
that has 2FA enabled:

```bash
npm publish --access public
```

Manual publishes should still happen from the same commit that is tagged and released.

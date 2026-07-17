# Releasing

`@concord-ai/concord-mcp` is published to npm with **trusted publishing (OIDC)** —
no long-lived `NPM_TOKEN` secret, and no 2FA one-time code in CI. Provenance is
generated automatically.

Publishing runs inside the `release` GitHub Actions environment, so npm only
accepts the publish from an approved, environment-scoped workflow run.

## One-time setup

Trusted publishing can only be configured after a package exists, so the very
first publish of the scoped package is done manually by an org member with publish
rights.

1. **First publish (local, once)** — from an account in the `concord-ai` npm org:

   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   npm publish --access public
   ```

   You'll be prompted for your npm 2FA code. This creates
   `@concord-ai/concord-mcp` under the org.

2. **Create the `release` GitHub environment** (repo → Settings → Environments):
   optionally add protection rules (required reviewers, restrict to `v*` tags) so
   a publish must be approved.

3. **Configure the trusted publisher** on npmjs.com:
   package → **Settings → Trusted Publisher → GitHub Actions** with:
   - Organization/user: `Get-Concord-AI`
   - Repository: `concord-mcp`
   - Workflow filename: `release.yml`
   - Environment name: `release`

## Every release after that

No token, no manual publish:

```bash
# bump the version (updates package.json and creates a commit + tag)
npm version patch   # or minor / major
git push --follow-tags
```

Pushing the `v*` tag triggers [`.github/workflows/release.yml`](./.github/workflows/release.yml),
which runs the full verification gate, publishes to npm via OIDC (with automatic
provenance), and creates a GitHub Release with generated notes. If the `release`
environment has required reviewers, the run pauses for approval first.

## Notes

- Keep [`CHANGELOG.md`](./CHANGELOG.md) up to date under `[Unreleased]`; move
  entries under the new version when you release.
- Requirements handled by the workflow: Node 24, npm >= 11.5.1, and
  `id-token: write` permission.

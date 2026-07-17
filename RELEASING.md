# Releasing

`get-concord-mcp` is published to npm with **trusted publishing (OIDC)** — no
long-lived `NPM_TOKEN` secret, and no 2FA one-time code in CI. Provenance is
generated automatically.

## One-time setup

Trusted publishing can only be configured after a package exists, so the very
first publish is done manually.

1. **First publish (local, once):**

   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   npm publish --access public
   ```

   You'll be prompted for your npm 2FA code. This creates the package.

2. **Configure the trusted publisher** on npmjs.com:
   package → **Settings → Trusted Publisher → GitHub Actions** with:
   - Organization/user: `Get-Concord-AI`
   - Repository: `concord-mcp`
   - Workflow filename: `release.yml`

## Every release after that

No token, no manual publish:

```bash
# bump the version (updates package.json and creates a commit + tag)
npm version patch   # or minor / major
git push --follow-tags
```

Pushing the `v*` tag triggers [`.github/workflows/release.yml`](./.github/workflows/release.yml),
which runs the full verification gate, publishes to npm via OIDC (with automatic
provenance), and creates a GitHub Release with generated notes.

## Notes

- Keep [`CHANGELOG.md`](./CHANGELOG.md) up to date under `[Unreleased]`; move
  entries under the new version when you release.
- Requirements handled by the workflow: Node 24, npm >= 11.5.1, and
  `id-token: write` permission.

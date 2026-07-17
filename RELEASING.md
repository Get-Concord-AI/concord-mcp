# Releasing

`@concord-ai/concord-mcp` is published to npm with **trusted publishing (OIDC)** —
no long-lived `NPM_TOKEN` secret, and no 2FA one-time code in CI. Provenance is
generated automatically.

By default the release workflow uses no GitHub environment (see the optional
gating section below to add maintainer approval).

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

2. **Configure the trusted publisher** on npmjs.com:
   package → **Settings → Trusted Publisher → GitHub Actions** with:
   - Organization/user: `Get-Concord-AI`
   - Repository: `concord-mcp`
   - Workflow filename: `release.yml`
   - Environment: **leave blank** (the workflow sets no environment)

   The Environment field must match the workflow exactly. Since `release.yml`
   sets no `environment:`, this field must be empty or npm will reject the OIDC
   token and the publish falls back to (missing) token auth — a `404` on publish.

### Optional: gate publishing behind approval

To require a maintainer to approve each publish (so people with repo access still
can't publish unilaterally), add it on **both** sides with the same name:

1. Create the environment (repo → Settings → Environments, e.g. `Release`) with
   required reviewers.
2. Add `environment: Release` to the `publish` job in `release.yml`.
3. Set the same **Environment** name on the npm trusted publisher.

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

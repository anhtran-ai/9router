# 9Router customization context

Last updated: 2026-07-18

This is the safe handoff file for continuing the customized 9Router work in a
new session. It intentionally contains no admin password, API key, OAuth token,
provider credential, Docker environment value, private key, or host address.

## Repository state

- Canonical customized repository: `https://github.com/azox-ai/azox-9router`
- Upstream repository: `https://github.com/decolua/9router`
- Active branch: `main`
- Current source commit: `226c4596d7bfd9ea1b0840e093e6eea6ebd41681`
- `origin/main` matched local `main` when this file was written.
- Upstream base tag: `v0.5.35` at `bc252ea80298d4879dc6b3c69585af1610d2c76f`
- Package version inherited from upstream: `0.5.35`
- Existing custom tag: `v0.5.35-anhtran` at `a6d9c50`.

Important: `v0.5.35-anhtran` contains the Contributors work but predates the
Combo Import/Export commits. The complete current build is `main` at
`226c459`; create a new tag before treating the full feature set as a release.

The local `upstream` remote is currently configured to fetch only tag
`v0.5.35`, not upstream branches. To inspect a newer upstream branch without
changing `main`, use an explicit refspec such as:

```bash
git fetch upstream refs/heads/master:refs/remotes/upstream/master --tags
```

## Implemented customization

### Contributors

The administrator can generate a scoped one-time link for another person to
contribute an OAuth account without receiving the 9Router admin password or
access to the dashboard.

- Sidebar order: `Remote` -> `Import / Export` -> `Contributors` -> `Settings`.
- Admin page: `/dashboard/contributors`.
- Contributor portal: `/contribute/[token]`, then `/contribute` after the token
  is exchanged for an HTTP-only contributor session cookie.
- Alias is required when generating a link and is shown in `Recent links`.
- Admin selects the allowed OAuth providers and an expiry from 15 minutes to
  24 hours. Claude and Codex are selected by default in the UI.
- The raw invite secret is displayed only in the newly generated URL. Only its
  SHA-256 hash is stored; comparison is timing-safe.
- A token can be claimed only once. The invite becomes `used` after the first
  successful OAuth completion and can be revoked while active.
- Contributor OAuth routes verify the contributor session and provider allow
  list before delegating to the upstream OAuth implementation.
- The contributor never receives the admin dashboard, existing connections,
  tokens, API keys, cookies, or other provider data.
- Invite/session state is stored in the existing SQLite `kv` table. The JWT
  signing secret is stored as a mode-`0600` file named `contributor-secret`
  under `DATA_DIR`.
- Admin APIs remain behind the dashboard's deny-by-default `/api/*` guard.
  Contributor session/OAuth APIs are public entry points but require the
  one-time token or signed contributor session and validate same-origin POSTs.

Contribution links must use the browser-visible public domain. Link generation
uses the validated request `Origin` first, then `BASE_URL` /
`NEXT_PUBLIC_BASE_URL`, forwarded host/protocol, or request origin. Never build
a contribution link from a container bind address such as `0.0.0.0`.

For authorization-code providers, the shared OAuth modal retains upstream
provider callback requirements. Codex uses
`http://localhost:1455/auth/callback`, xAI uses
`http://127.0.0.1:56121/callback`, and other providers use the application port.
On a remote 9Router domain, the modal falls back to asking the contributor to
paste the callback URL when the local callback proxy cannot be used.

### Combo Import / Export

- Admin page: `/dashboard/import-export`.
- API: `/api/import-export/combos`.
- Only Combo definitions and routing strategy are transferred: name, kind,
  ordered models, fallback strategy, and Fusion judge model.
- Provider connections, OAuth credentials, API keys, usage, aliases, and all
  unrelated settings are never exported or modified.
- Export opens a 9Router-style modal listing current combos. All are selected
  by default; the admin may select individual items or `Select all`.
- Export format is `9router-combos`, version `1`, as a timestamped JSON file.
- Import accepts the current export envelope, a raw array, or compatible
  `combos`/`items` payloads.
- Conflict policy is `update` or `skip`, matched by combo name.
- Limits: 2 MB request, 500 combos per import, 200 models per combo, validated
  names and strategies.
- The result panel reports total, created, updated, skipped and failed counts,
  plus a per-combo action and detail. Combo rotation is reset for created or
  updated items.

The ten combos created during local UI testing were runtime test data only and
are not part of the source repository or export defaults.

## Main source locations

- `src/app/(dashboard)/dashboard/contributors/page.js`
- `src/app/contribute/page.js`
- `src/app/contribute/[token]/page.js`
- `src/app/api/contributor-admin/invites/route.js`
- `src/app/api/contribute/session/route.js`
- `src/app/api/contribute/oauth/[provider]/[action]/route.js`
- `src/lib/contributor/store.js`
- `src/lib/contributor/session.js`
- `src/app/(dashboard)/dashboard/import-export/page.js`
- `src/app/api/import-export/combos/route.js`
- `src/lib/db/repos/combosRepo.js`
- `src/shared/components/Sidebar.js`
- `src/shared/components/Header.js`
- `src/shared/components/OAuthModal.js`
- `scripts/start-contributor-local.ps1`
- `scripts/stop-contributor-local.ps1`

## Commit sequence after upstream v0.5.35

The meaningful feature commits, in dependency order, are:

1. `79c041a` — scoped one-time contributor OAuth portal.
2. `e8dbc87` — Contributors navigation and invite aliases.
3. `824a117` — Contributors navigation/layout refinement.
4. `8a99963` — remote fixed-port OAuth callback behavior.
5. `ca174f2` — contribution links generated from public origin.
6. `c1b952b` — Combo Import/Export module.
7. `226c459` — selectable Combo export modal, default select all.

`a6d9c50` is the custom repository initialization merge and `790ef29` is its
repository-history parent; they are not standalone product features.

## Persistence and deployment

The verified workstation deployment currently runs container
`llm-gateway-9router` from image
`llm-gateway/9router-contributor:0.5.35-226c459`. Its persistent state is in
Docker volume `llm-gateway_ninerouter-data`.

9Router state—including settings, API keys, connected providers, OAuth data,
combos, contributor invites, and `contributor-secret`—lives under `DATA_DIR`.
Updating the application image is safe only when the same persistent volume is
mounted at `/app/data`.

Never run `docker compose down -v`, delete the data volume, replace it with an
empty mount, or copy a blank database over the live database during an update.
Back up the volume/database before changing the image. Build and replace only
the application container while preserving its environment and mounts.

The repository's example Compose file uses a named `9router-data` volume; the
existing workstation stack uses the stack-specific volume named above. Do not
change a live deployment to the example volume name without migrating data.

The local helper starts the production build at `127.0.0.1:21128` with
`runtime-data` as its isolated `DATA_DIR`. Its default password is test-only and
must never be reused in a deployed environment.

## Verification snapshot

- `npm run build` passed on 2026-07-18 and included the Contributors and
  Import/Export pages and APIs in the production route manifest.
- `npm audit --omit=dev` currently reports five inherited findings: one low
  and four moderate, involving DOMPurify/Monaco and PostCSS/Next.js.
- Do not run `npm audit fix --force` blindly; the suggested DOMPurify path
  changes Monaco across a breaking version, while the reported bundled
  PostCSS issue had no fix in the installed dependency graph.
- There are no dedicated automated tests for the custom Contributors and
  Combo Import/Export routes yet. Production build success is not a substitute
  for security and integration tests; add them before proposing upstream.

## Upgrade and upstream contribution guidance

For a future upstream update:

1. Back up the live data volume first.
2. Fetch the desired upstream branch/tag explicitly.
3. Create an upgrade branch from that upstream release.
4. Reapply or cherry-pick the seven meaningful feature commits in the order
   listed above, resolving upstream conflicts narrowly.
5. Run production build, unit/integration tests, Contributor OAuth tests, and
   Combo import round-trip/conflict tests.
6. Build an immutable image tagged with the upstream version and Git commit.
7. Replace the container without changing or deleting the data volume.
8. Smoke-test admin login, existing providers/API keys, Contributors, callback
   domain generation, and Combo Import/Export.

To contribute upstream, create a clean feature branch from the latest
`decolua/9router` branch, split Contributors and Import/Export into reviewable
pull requests, add tests and documentation, and expect maintainer review and
approval. Opening a pull request does not merge it automatically.

## Non-negotiable rules

1. Never commit or print `.env`, admin passwords, API keys, provider tokens,
   callback authorization codes, `contributor-secret`, SQLite runtime data, or
   Docker volume contents.
2. Never expose the admin dashboard or admin APIs to a contributor session.
3. Never allow an invite to use a provider outside its stored allow list.
4. Never include credentials or unrelated settings in Combo export/import.
5. Derive contribution links from the public browser origin/configured domain,
   not bind host or internal container address.
6. Preserve `DATA_DIR` and its volume during every build/deploy/update.
7. Keep customization diffs small and separated from upstream code where
   practical to make future rebases and pull requests manageable.

## Recommended first prompt in a new session

> Read `SESSION_CONTEXT.md`, verify local `main` against `origin/main`, inspect
> the current upstream branch/tag, and continue the customized 9Router work
> without exposing runtime secrets or changing/deleting the persistent Docker
> volume.

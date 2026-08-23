# 9Router customization context

Last updated: 2026-08-23

This is the safe handoff file for continuing the customized 9Router work in a
new session. It intentionally contains no admin password, API key, OAuth token,
provider credential, Docker environment value, private key, or host address.

## Repository state

- Canonical customized repository: `https://github.com/azox-ai/azox-9router`
- Upstream repository: `https://github.com/decolua/9router`
- Current reviewed branch: `main`
- Upstream integration commit: `ab0de796`.
- Pre-upgrade deployed source commit:
  `a3ec8af4c9e6243e860e163d535f3af6dec324a5`
- Target upstream tag: `v0.5.55` at
  `699edac3273e13d4744bc46f6082618f08560702`
- Candidate package version inherited from upstream: `0.5.55`
- Reviewed/deployed source commit:
  `0522ca95d86ec42dafc930ef05f57b7e6d561962` (PR `#13`, Fable 5 prefill
  capability hotfix)
- Existing custom tag: `v0.5.35-anhtran` at `a6d9c50`.

The verified live deployment now runs
`llm-gateway/9router-contributor:0.5.55-azox.1-0522ca95`, image ID
`sha256:bc33d935a0681dc343b5e91c381a63e2da890a64c932c38d5e776348e6cd53dd`.
It was deployed on `zbs3` on 2026-08-23 after explicit approval; the container
started at `2026-08-23T07:51:05Z` and has restart count `0`. The image is local
to the host and was not published to a registry.

The repeatable upgrade procedure and worked examples are in
`docs/UPSTREAM_UPGRADE_HANDBOOK.md`.

Configure the local `upstream` remote to fetch the upstream branch and tags.
To inspect a newer upstream branch without changing `main`, use an explicit
refspec such as:

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
`llm-gateway/9router-contributor:0.5.55-azox.1-0522ca95`. Its persistent state
remains in Docker volume `llm-gateway_ninerouter-data`. The checksum-verified
cutover backup is retained at
`/srv/llm-gateway/backups/azo559-9router-20260823-074433/`; its quiesced
`ninerouter-data.tar.gz` archive is `28,187,639` bytes with SHA-256
`7fbbf8030be9d84e4d40ac7e7b67482095aa55dca911738276dbc4c556d526ae`.
The checksum and pre-cutover Compose checksum both verify successfully.

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

- On 2026-08-23, the four dedicated Contributor/OAuth/Combo files passed
  `14/14`, and the capability/prefill/trailing-assistant focused gate passed
  `15/15`.
- The full candidate suite was compared with a clean `v0.5.55` worktree on the
  same Linux host. No deterministic candidate-only failure identity remained;
  observed deltas were inherited or environment-sensitive SQLite/time-out
  failures. Treat raw totals as environment-sensitive and zero deterministic
  new failure identity as the acceptance gate.
- `npm run build` passed and included Contributor and Import/Export pages and
  APIs in the production route manifest.
- An isolated server using a fresh temporary `DATA_DIR` returned HTTP `200`
  for `/api/health` and `/api/v1/models`; Contributor and Import/Export pages
  followed the expected login redirect policy.
- The root dependency graph is locked in `package-lock.json`; Docker copies it
  and uses `npm ci --legacy-peer-deps` so the candidate build is reproducible.
  Webpack explicitly externalizes the optional native `better-sqlite3` package
  so the documented database fallback works when npm skips that package.
- `npm audit --omit=dev --audit-level=high` reported three high and three
  moderate inherited findings in Next/PostCSS/Sharp and Monaco/DOMPurify.
  PostCSS and Sharp had no available fix; the DOMPurify recommendation requires
  a breaking Monaco update. Do not use `npm audit fix --force`.
- The initial upgrade snapshot at
  `/srv/llm-gateway/backups/azo530-9router-20260823-053902/` passed checksum,
  restore, migration, and old-image rollback rehearsal. The later Fable 5
  hotfix cutover used a new quiesced, checksum-verified backup at
  `/srv/llm-gateway/backups/azo559-9router-20260823-074433/` before recreating
  only the 9Router service.
- Production retained `14` combos, `5` provider connections, `9` KV records,
  settings, API-key state, and the existing contributor signing secret;
  SQLite integrity was `ok` before and after cutover.
- Post-hotfix health, model discovery, auth guards, Contributor and Import /
  Export routes, and inference smoke checks passed. Trailing-assistant requests
  returned HTTP `200` for Fable 5 single and `cc/*` routes, Fable-to-GPT combo,
  Opus 5, Sonnet 5, Haiku 4.5, and LiteLLM `mix/model-max`, `mix/model-high`,
  and `mix/model-medium`; the fresh nine-case matrix was `9/9`, with zero
  prefill or `invalid_request_error` log matches.
- The immediate rollback image
  `llm-gateway/9router-contributor:0.5.55-azox.1-cbcb0b90` remains available as
  image ID
  `sha256:6cba663f4d91c642381fcdbbdb9e968706752f242209698979bcf6d44f82c74e`.
  Rollback restores that tag in Compose and recreates only `ninerouter` with
  `docker compose up -d --no-deps --force-recreate ninerouter`, preserving the
  data volume. The earlier `0.5.45-azox.1-a3ec8af4` image also remains local.

## Upgrade and upstream contribution guidance

Follow `docs/UPSTREAM_UPGRADE_HANDBOOK.md` for every upstream update. It is the
authoritative procedure for release selection, conflict resolution, baseline
comparison, isolated migration checks, immutable images, approval gates,
rollback, and Knowledge closeout.

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

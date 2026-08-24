# Upstream upgrade handbook

Status: Active

Owner: Azox principal

Applies to: `azox-ai/azox-9router`

Upstream: `decolua/9router`

## Purpose

Upgrade the private Azox downstream to a reviewed upstream release while
preserving the Contributor portal, Combo Import/Export, security boundaries,
runtime data, and a tested rollback target.

Use a fixed upstream tag. Never upgrade a deployed service directly from the
moving upstream `master` branch or a floating container tag.

## Non-negotiable invariants

1. Keep `azox-ai/azox-9router` private and independent; use an `upstream`
   remote rather than changing the repository into a public GitHub fork.
2. Never rewrite or force-push `main` to absorb upstream history.
3. Never print or commit provider credentials, OAuth material, API keys,
   runtime databases, `.env` files, or contributor secrets.
4. Every Contributor OAuth request must pass through
   `/api/contribute/oauth/*`, validate the contributor session, and enforce the
   invite provider allowlist. It must never fall back to `/api/oauth/*`.
5. Combo transfer contains definitions and routing strategies only. It never
   contains provider connections, credentials, API keys, usage, aliases, or
   unrelated settings.
6. Preserve `DATA_DIR` and the live persistent volume. Never use
   `docker compose down -v` during an upgrade.
7. Production deployment, publishing an image/release, and authentication or
   authorization changes require explicit human approval.

## Fork runtime seams that upgrades must preserve

`docs/CUSTOMIZATIONS.yaml` is the machine-readable source of truth. Current
high-risk runtime seams have separate classifiers and must not be collapsed:

- Claude assistant prefill is decided by target format at the final translated
  and native passthrough boundaries, never by model name. Preserve the additive
  policy module, both call sites, focused tests, and the explicit
  `x-9router-assistant-prefill: preserve` escape hatch.
- Combo model fallback is separate from account fallback. Only HTTP `400` with
  exact text `does not support assistant message prefill` advances to the next
  combo model without account cooldown or rotation. Other `400` responses stop;
  existing `401`, `403`, `404`, `429`, and `5xx` account/error handling remains.
- Codex Responses compatibility belongs at `open-sse/executors/codex.js`:
  developer instructions are hoisted, and only `content` is removed from
  `additional_tools` items. This is provider compatibility for the Codex OAuth
  backend, not a mandatory OpenAI Responses specification rule.

Community/upstream work `decolua/9router#2796` and `#2508` uses the same
`additional_tools.content` normalization pattern. Bugs `#2497` and `#3390`
remain open references. During each upstream upgrade, inspect their current
state. If upstream has merged equivalent behavior, delete the downstream seam
only after focused tests and a direct `cx/*` Codex CLI Responses check pass.

## Repository setup

Verify the remotes before every upgrade:

```bash
git remote -v
git remote get-url origin
git remote get-url upstream
```

Expected identities:

```text
origin   https://github.com/azox-ai/azox-9router.git
upstream https://github.com/decolua/9router.git
```

Add upstream once when absent:

```bash
git remote add upstream https://github.com/decolua/9router.git
```

Fetch without changing the checkout:

```bash
git fetch origin main
git fetch upstream master --tags
```

Confirm the desired tag and commit:

```bash
git show --no-patch --decorate <upstream-tag>
git merge-base origin/main <upstream-tag>
git rev-list --left-right --count origin/main...<upstream-tag>
```

## Phase 1: scope and risk review

Record before editing:

- current Azox commit and deployed image/digest;
- target upstream tag and commit;
- commits on each side since the merge-base;
- files changed on both sides;
- upstream changelog, schema changes, OAuth changes, dependency changes, and
  provider-registry changes;
- acceptance criteria and risk rating.

Authentication, persistence, migrations, public API behavior, and routing
changes are high-risk even when Git reports no textual conflict.

Forecast conflicts without touching `main`:

```bash
base=$(git merge-base origin/main <upstream-tag>)
git diff --name-only "$base"..origin/main
git diff --name-only "$base"..<upstream-tag>
git merge-tree --write-tree origin/main <upstream-tag>
```

On PowerShell, compute `$base` with `git merge-base` and pass the same revision
ranges as quoted strings.

## Phase 2: integration branch

Start from the current reviewed Azox `main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/upgrade-upstream-<version>
git merge --no-ff --no-commit <upstream-tag>
```

Using a merge commit preserves both histories and avoids rewriting deployed
Azox commits. Do not resolve conflicts with blanket `ours` or `theirs`.

For each conflict:

1. understand the upstream semantic change;
2. retain the upstream architecture or provider behavior;
3. reapply the smallest Azox customization;
4. verify the Contributor and export boundaries explicitly;
5. add a regression test for any subtle resolution.

Common conflict areas are `OAuthModal.js`, `Sidebar.js`, and `Header.js`.
When upstream adds OAuth actions, update the guarded Contributor action
allowlist deliberately and ensure the modal uses its injected `apiBase` for
authorize, exchange, polling, proxy lifecycle, and IDE detection.

Check resolution hygiene:

```bash
git diff --check
git status --short
rg -n '^(<<<<<<<|=======|>>>>>>>)' .
```

## Phase 3: required tests

Install the root dependency graph from the committed lockfile:

```bash
npm ci --legacy-peer-deps
cd tests && npm install
```

The Docker build must copy `package-lock.json` and use
`npm ci --legacy-peer-deps`; the peer mode must match the mode used to generate
this lockfile. Optional native accelerators such as `better-sqlite3` must remain
external to the server bundle so a host that skips them can use the database
driver's `node:sqlite` or `sql.js` fallback. Do not change dependency versions
merely to make an environment pass, and never regenerate the lockfile as an
incidental side effect of an upgrade.

Run focused Azox tests first:

```bash
cd tests
npx vitest run \
  unit/contributor-store.test.js \
  unit/contributor-oauth-guard.test.js \
  unit/combo-import-export.test.js \
  unit/oauth-register-session.test.js
```

The focused suite must verify:

- one-time and expiring contributor tokens;
- hashed invite secrets and redacted admin listings;
- session and provider allowlist enforcement;
- same-origin checks for state-changing requests;
- guarded proxy-session registration;
- invite consumption after successful OAuth;
- combo export excludes unrelated settings;
- import normalization, conflict policy, limits, and rotation reset.

Run the full upstream suite and the committed no-regression gate. Because the
upstream known-failure file can lag the current release or behave differently
by OS, also run the same suite on an untouched worktree of the target tag and
compare failure identities. Never add failures to an allowlist merely to make
the candidate green.

Write both runs with Vitest's JSON reporter, then compare them with:

```bash
node scripts/compare-test-results.mjs \
  <candidate-results.json> \
  <clean-upstream-results.json>
```

Required outcome:

```text
candidate failures minus clean-upstream failures = 0
```

Then run:

```bash
npm run build
```

Set `DATA_DIR` to an isolated temporary directory during build and smoke tests
so validation never opens a user's default runtime database.

## Phase 4: isolated runtime and migration checks

Start the production build on a loopback-only alternate port with a fresh
temporary `DATA_DIR`. Verify:

- `/api/health` returns `200`;
- `/api/v1/models` returns `200`;
- Contributor and Import/Export routes appear in the build manifest;
- admin pages follow the configured `require-login` policy (test both enabled
  and disabled configurations when that behavior changed);
- no credential or request payload is written to logs.

Next, test migration using a protected copy of the deployed data volume:

1. checkpoint SQLite/WAL safely; when the application image ships no `sqlite3`
   CLI, run the checkpoint and `integrity_check` through the image's bundled
   `node:sqlite` runtime and report only the result, never row contents;
2. create a timestamped backup without printing contents; for the production
   snapshot, stop only the application container for the archive step and arm a
   restart trap before stopping it, so an interrupted planned downtime cannot
   leave the service stopped;
3. restore the backup to a separate test volume;
4. mount only the test volume into the candidate container;
5. verify login, settings, providers, keys, aliases, combos, invite state, and
   contributor-secret continuity;
6. prove rollback by starting the previous image against a separate restored
   copy, not by experimenting on the only backup.

Never mount the live volume into a candidate container for migration testing.

## Phase 5: review and immutable candidate

The pull request must include:

- upstream tag and commit;
- merge-base and divergence counts;
- conflict files and resolution rationale;
- focused-test results;
- full-suite candidate-vs-upstream comparison;
- production-build result;
- isolated smoke and migration evidence;
- security-sensitive changes;
- rollback plan and unresolved risks.

After approval, build an immutable image such as:

```text
llm-gateway/9router-contributor:<upstream-version>-azox.<n>-<git-sha>
```

Record both the Git commit and resulting image ID/digest. Publishing the image
or creating a release/tag requires explicit human approval.

## Phase 6: production rollout

Production rollout requires a separate explicit approval after the PR,
candidate image, backup, migration test, and rollback evidence are available.

Immediately before rollout:

- verify the live container image, mounts, environment references, and health;
- verify that the dedicated Docker operator account can read the required
  environment reference, update the Compose file, and create files in the
  backup directory; request only those minimum ACLs, and test them without
  printing any environment value;
- create and verify a fresh backup;
- confirm the prior immutable image is locally available;
- confirm the rollback command and responsible operator;
- preserve the existing volume mount at `/app/data`.

Replace only the application container. Do not recreate or delete data
volumes. After rollout, verify health, login, existing connections, model
discovery, one approved end-to-end request, Contributor, and Combo
Import/Export. Roll back on migration errors, auth regressions, elevated error
rate, missing models, or failed custom-feature checks.

## Phase 7: closeout

Update `SESSION_CONTEXT.md` and canonical Azox Knowledge with:

- merged commit and upstream release;
- image tag and digest;
- deployment timestamp and host;
- backup/restore evidence;
- verification results;
- rollback target;
- known inherited failures and remaining risks.

Future upgrades begin from this evidence, not from chat history.

## v0.5.45 worked example

The 2026-08-02 candidate upgrade from `v0.5.35` to `v0.5.45` started from merge-base
`bc252ea80298d4879dc6b3c69585af1610d2c76f`. At inspection time, upstream had
50 commits and Azox had 12 commits after that base. Three files overlapped;
`OAuthModal.js` and `Sidebar.js` conflicted, while `Header.js` auto-merged.

The resolution retained the upstream OAuth/provider expansion, kept both the
upstream `9English` navigation and the Azox Contributor/Import-Export entries,
and routed new proxy OAuth actions through the Contributor `apiBase`. A
regression test also caught and fixed the upstream `register-session` handler
reading an undefined variable. Four focused test files passed 14 tests, the
candidate introduced zero failures relative to a clean `v0.5.45` worktree on
the same Windows environment. A clean production build passed without the
optional `better-sqlite3` package by using `sql.js`, and isolated localhost
smoke checks returned `200` for health, models, Contributor, and Import/Export
with login disabled in the fresh test data.

After explicit production approval, PR #4 was merged by fast-forward so the
upstream merge history remained intact. A checksum-verified volume snapshot
was restored twice: the candidate passed migration on one isolated volume and
the previous image passed rollback rehearsal on another. Production then
replaced only the 9Router application container and retained the existing
`llm-gateway_ninerouter-data:/app/data` mount. Post-cutover SQLite integrity
was `ok`; all 15 combos, 4 provider connections, 5 KV records, settings, and
the contributor signing secret matched the tested state. Health, authentication
status, login guards, and a LiteLLM-to-9Router inference smoke passed. The two
test volumes were removed, while the verified backup and previous immutable
image were retained for rollback.

## v0.5.55 worked example

The 2026-08-23 rollout upgraded the deployment from `v0.5.45` to upstream
`v0.5.55` (`699edac3273e13d4744bc46f6082618f08560702`). The reviewed source was
`cbcb0b904a8cb05e39d8a1874d21cac3667dd851`; Contributor/OAuth/Combo tests
passed `14/14`, capability/prefill/trailing-assistant tests passed `15/15`, the
production build passed, and comparison with a clean upstream worktree left
zero deterministic new failure identity. Beyond the upstream merge, the
release dropped fork-only routing code and fixed the trailing assistant prefill
path by declaring an `assistantPrefill` capability and normalizing a trailing
assistant message.

Two operational lessons are now folded into Phase 4 and Phase 6. First, the
application image ships no `sqlite3` CLI, so the WAL checkpoint and integrity
check ran through the image's `node:sqlite` runtime. Second, the dedicated
Docker operator account initially could not read the Compose environment
reference, update the Compose file, or write the backup directory; rollout
resumed only after minimum read, write, and directory ACLs were granted and
verified without printing any value.

The production snapshot stopped only the 9Router container under a restart trap
for roughly `43` seconds, then archived `/app/data` to the checksum-verified
`/srv/llm-gateway/backups/azo530-9router-20260823-053902/`. Restore and
old-image rollback rehearsal both passed on a separate test volume.

Cutover changed only the 9Router service image to
`llm-gateway/9router-contributor:0.5.55-azox.1-cbcb0b90` and recreated that
service alone; the four sibling containers kept their identity and restart
count. Post-deploy checks confirmed the reported version, model discovery,
governance guards on Contributor and Import/Export surfaces, LiteLLM inference,
host health, unchanged data counts with `integrity_check=ok`, and HTTP `200` for
both the original trailing-assistant case and its image variant. The previous
immutable image and the verified backup remain available for rollback.

## Prefill and Codex Responses release worked example

The 2026-08-23/24 release replaced model-name prefill capability handling and
fixed two Codex Responses compatibility defects across three merges:
`b5ccd109487a6f53bbb7fc8771f2c8f9ee79b179` (PR `#19`),
`57c31404508c783b3e961b6bbf4e6c7df0ae05e9` (PR `#20`), and
`fcf4300e6e0b263ad28a8a475a18702cb7c6774c` (PR `#21`). The deployed image is
`llm-gateway/9router-contributor:0.5.55-azox.1-fcf4300e`, image ID
`sha256:bae7c6eb0d38fa587565aaaf98d42f3cb20b2379e0545d17583a850222b7e16a`,
built from the source archive with SHA-256
`2bf30893094cc04141d7d07c6eefa35b32b26d842f8d66c9d76383d06bdfa7ce`. Rollback
target is source `57c31404`, whose immutable image remains on the host.

Three lessons are now mandatory for this deployment:

1. 9Router is upstream of LiteLLM, which serves the operating agent's own LLM
   API. Run cutover as a single self-contained host script launched detached
   (`setsid nohup`) with built-in backup, checksums, build, service-scoped
   recreate, health, integrity, smoke, and health/integrity auto-rollback, then
   poll its log. A foreground cutover can lose its own API mid-recreate. The
   final run logged `PID`, `PPID`, `detached=yes`, and `RESULT=SUCCESS`.
2. Protocol-level `curl` checks are not sufficient acceptance. Verify with the
   real clients: `codex` CLI and `claude` CLI across direct `cx/*`, direct
   `cc/*`, both combo directions, and all `mix/*` aliases. The `cx/*`
   `Unknown parameter: 'input[0].content'` defect was invisible to protocol
   tests that passed. The final matrix passed `18/18` with trailing-assistant
   prefill `10/10`, `unknown_input_content=0`, and no default-case prefill
   `400`.
3. Exercise combo fallback with the `x-9router-assistant-prefill: preserve`
   seam as a deterministic hard-fail source instead of changing live
   configuration or burning Claude quota.

A functional regression on healthy storage stops the matrix and escalates; it
is not a reason to roll back automatically. Container timezone for 9Router and
LiteLLM is `Asia/Ho_Chi_Minh`, while host-level Docker output may still print
UTC, so compare timestamps by explicit offset.

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

Before planning any upgrade, read the generated
[`FORK_DIFF_INVENTORY.md`](FORK_DIFF_INVENTORY.md) beside the machine-readable
[`CUSTOMIZATIONS.yaml`](CUSTOMIZATIONS.yaml). The registry defines allowed
fork boundaries; the inventory maps every path to behavior, upgrade action, and
tests. `node scripts/check-customization-boundary.mjs` fails when either source
or the actual upstream diff drifts.

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
- Combo model fallback is separate from account fallback. HTTP `400` matching
  the prefill phrase or recognized unsupported-tool phrases in
  `isModelCompatibilityError` advances to the next model without account cooldown
  or rotation. Other `400` responses stop. Exhausted combos select a coherent
  status/message pair, preferring the latest `429`/`5xx` failure if present;
  thrown attempts count as `500`. Read retry timing from actual HTTP headers as
  well as legacy JSON metadata, and classify the app's real no-active-credentials
  response. Confirmed cancellation is terminal: propagate the request signal,
  do not advance accounts/models or cool a healthy account for `AbortError`/`499`.
  Keep provider failures/timeouts and ordinary `400` controls distinct.
- Codex Responses compatibility belongs at `open-sse/executors/codex.js`:
  developer instructions are hoisted, and only `content` is removed from
  `additional_tools` items. This is provider compatibility for the Codex OAuth
  backend, not a mandatory OpenAI Responses specification rule.
- Hosted tool normalization must retain native access/discovery constraints,
  independent MCP configurations and selectors, and explicit custom-tool identity.
  Do not mutate tool objects shared by combo attempts. Keep hosted tools in the
  intermediate representation for compatible targets, but filter them and repair
  tool choices at the final Chat Completions boundary. An empty allowed subset or
  removed forced selector must not enable unrelated functions: use `none` when
  other declarations remain. Preserve bare Claude client schemas even when their
  names match hosted aliases.

The follow-up self-review repair is tracked by
[#35](https://github.com/azox-ai/azox-9router/issues/35), with stable IDs
`SR-01`–`SR-11` in the registry. Preserve these additional contracts:

- Native Codex `allowed_tools` retains its mode and exact permitted identities;
  malformed/unavailable selections return a typed compatibility error instead
  of removing the restriction. Native function `strict`/`defer_loading` and
  image-generation `action`/`input_image_mask` survive normalization.
- Format conversion preserves disabled, required, forced and subset choices.
  Keep real Claude hosted declarations distinct from client functions in the
  intermediate representation, including the actual Claude input parser.
- Responses domain filters map to compatible Claude domain fields. Claude
  cannot express Responses cache-only web access or an explicit indexed-access
  constraint; return `400 / unsupported_tool_constraint` rather than drop them.
- Native Chat custom tools are supported only on the Chat target. All other
  actual pipelines, including Responses, return the same typed compatibility
  error until their response paths preserve native custom calls. Keep this guard
  at both the central translator and the direct Responses converter: GitHub/Zed
  can choose a Responses transport after the declared target was Chat. Preserve
  already-native Responses passthrough and the separate Responses custom-wrapper
  path; do not equate a correct request shape with a supported return path.
- Handle typed compatibility errors at both translation and executor boundaries.
  Combo may try another compatible target without account cooldown; never
  convert these local request constraints into generic provider `502` errors.

SR-01, SR-02 and SR-04 remain corrections to PR #24; other SR entries predate
PR #34. Consult each entry's provenance rather than attributing every issue
to customization. These are source contracts, not a live-provider acceptance
claim. The issue #43 candidate pins upstream `v0.5.69`; production remains on
its separately recorded immutable image until review and rollout approval.

The next review round covers [#36](https://github.com/azox-ai/azox-9router/issues/36),
[#38](https://github.com/azox-ai/azox-9router/issues/38),
[#39](https://github.com/azox-ai/azox-9router/issues/39),
[#40](https://github.com/azox-ai/azox-9router/issues/40), and
[#41](https://github.com/azox-ai/azox-9router/issues/41). Keep these
additional regression gates during upgrades:

- Responses custom wrappers must survive actual Chat/Claude/Gemini JSON and
  forced-SSE return paths, including Array/Set metadata and exact raw input.
  Preserve ordinary function calls, IDs, text/thinking, usage and native payloads.
  This does not remove SR-07's separate incoming native Chat custom guard.
- Validate the upstream response before success or usage callbacks. Arbitrary
  JSON, error envelopes, non-SSE bodies advertised as streaming, and truncated
  streams are failures. Return `502 / invalid_upstream_response` before streaming
  headers; after headers emit the client's safe protocol error. Preserve early
  deltas/backpressure, valid empty/tool-only responses, legitimate token-limit
  `response.incomplete`, and once-only cancellation/completion. Executors that
  convert a transport into SSE must advertise its actual media type.
  Recover authoritative terminal output when deltas were absent, without
  duplicating already delivered output. Reject conflicting Responses tool
  name/type/item/call identity before terminal recovery, and malformed Gemini
  content/parts before forwarding, for native and translated clients alike.
  A valid global semantic terminal ends
  the stream promptly; cancel unused upstream bytes instead of waiting for
  transport EOF. Do not promise inspection of unconsumed trailing bytes.
  Keep explicitly requested native Responses background results and the narrow
  Claude `max_tokens + content:null` to `content:[]` compatibility normalization.
- At the final Codex boundary, retain representable Claude domain restrictions
  and `parallel_tool_calls:false`. Reject constraints the Codex backend cannot
  enforce, conflicting duplicate web-search declarations, and forced/required
  tools removed by filtering. Keep the original declarations for compatible
  combo fallback without account cooldown. The wider Responses API and the
  Codex OAuth backend are distinct capability contracts.
- Independent usage writes must remain distinct even with identical timestamps,
  accounts and token counts. History, daily and lifetime counters stay atomic;
  do not mutate caller entries or deduplicate recent views by coincidence.
  The request lifecycle owns once-only recording. This patch does not migrate
  the schema or reconstruct previously omitted historical usage.
- The sql.js fallback must produce a real, reopenable lightweight backup before
  migrations: include current in-memory critical rows/schema, exclude the large
  `requestDetails` log, and do not mutate/export the entire source to obtain it.
  Keep native-adapter backup behavior and the existing best-effort migration
  policy. A helper must throw on a failed backup rather than return a false
  success path. Verify file contents by reopening, not just pathname existence.

The JSON/SSE gaps were reproduced on both `c9a1c3af` and `23feb40b`; they do not
establish the live LiteLLM/Claude CLI incident cause. Issue #39 has mixed upstream
and fork origins recorded per path. Issue #40 comes from upstream `0d216689`;
the sql.js backup gap in #41 comes from upstream `b25e1016`.
Carry the tests first and retire only patches proven redundant upstream.

Protocol references: [Claude streaming event flow](https://platform.claude.com/docs/en/build-with-claude/streaming)
and [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).

Community/upstream work maps to two distinct Codex Responses seams:
`decolua/9router#2508` hoists instruction/system-prompt content into top-level
`instructions`, while `#2796` removes `content` from `additional_tools` items.
Bugs `#2497` and `#3390` remain open references. During each upstream upgrade,
inspect their current state. If upstream has merged equivalent behavior, delete
only the matching downstream seam after focused tests and a direct `cx/*`
Codex CLI Responses check pass.

### Tool compatibility repair register (2026-08-26)

The `compatibility_fixes` array in `CUSTOMIZATIONS.yaml` and generated inventory
map each issue to its source boundary, behavior, regression files, and retirement
action. Issues [#25–#31](https://github.com/azox-ai/azox-9router/pull/24) were
introduced by fork PR #24 (`31296537`); [#32](https://github.com/azox-ai/azox-9router/issues/32)
was already present in upstream `v0.5.55` (`699edac3`). The two P1 repairs are
native web-search access flags (#27) and shared tool mutation during fallback
(#28). These are source findings, not claims of a production incident.

For each upstream upgrade:

1. Compare the new pinned upstream implementation against each register entry;
   do not replay the entire old executor or translator file over upstream.
2. Carry the regression tests forward first, then retain only missing behavior.
   Drop a redundant patch only when equivalent upstream code passes the tests.
   Keep `hostedToolPolicy.js` and final-target filtering distinct from the pivot.
3. Run the focused gate below, the other fork feature gates, a same-environment
   full-suite comparison against clean upstream, and a production build. The
   full suite has inherited failures; report exact new failure identities and
   collection/suite errors, not only totals. Do not edit known-fail snapshots to
   conceal new regressions.
4. Review the required client matrix separately before a production rollout.
   Offline request-shape tests do not prove provider support or successful live
   tool execution. Publishing/deploying still requires human approval.

Focused gate (from `tests/`, no credentials or provider calls):

```sh
npx vitest run unit/codex-tool-normalization.test.js unit/hosted-tool-policy.test.js unit/unsupported-tool-fallback.test.js unit/account-fallback-prefill.test.js translator/hosted-tools-to-claude.test.js translator/hosted-tools-matrix.test.js translator/assistant-prefill-policy.test.js unit/customization-boundary.test.js
```

For a source-only fork fix, compare the complete offline suite with the exact
pre-fix fork SHA in another worktree. Use identical Node/Vitest versions, exclude
`**/*.real.test.js`, disable live/E2E gates, and isolate both `DATA_DIR` and the
process home/profile (usage storage does not fully honor `DATA_DIR`). Block
external network calls; some upstream tests are ungated. Preserve both JSON
reports and run `scripts/compare-test-results.mjs`; it compares assertion,
collection/suite and run-level error identities, including failed hooks with
passing tests and global unhandled rejections.

The reusable runner implements these safeguards without changing the upstream
test files. Run from the candidate repository root, once per fresh output path:

```sh
node scripts/offline-tests/run-offline.mjs /path/to/baseline ../9router-audit/baseline
node scripts/offline-tests/run-offline.mjs . ../9router-audit/candidate
node scripts/compare-test-results.mjs ../9router-audit/candidate/vitest.json ../9router-audit/baseline/vitest.json
```

Install both worktrees' dependencies first. The runner uses the same base Vitest
config, four fork workers and zero retries; records commands/SHAs/versions, JSON
results, failure identities and blocked attempts; and refuses to overwrite a run.
Keep `vitest.json`, `run.json` and `run-errors.json` together for each result.
The custom reporter captures Vitest's `onTestRunEnd` error channel because the
ordinary JSON reporter can report passing assertions even when an unhandled
rejection makes the process exit nonzero. Missing, interrupted, incomplete or
inconsistent evidence makes the comparator exit `2`, not report success; a new
failure identity exits `1`. Re-run older baselines with the current collector
instead of fabricating missing sidecars or relying only on JSON `success`.
Vitest 4 can also log global teardown/resource-close errors after that reporter
hook without changing its exit status. The reporter preserves the framework's
structured `error during close` diagnostic as a lifecycle error and makes the
run fail. The public `onProcessTimeout` hook marks leaked-handle shutdowns
incomplete and nonzero, even if all assertions passed. This integration is
version-sensitive: retain the real rejection, global-teardown and leaked-handle
fixtures when upgrading Vitest; do not approve a collector from unit JSON
fixtures alone. See the [reporter lifecycle](https://vitest.dev/guide/advanced/reporters.html).
Only worker-owned ephemeral loopback fixtures can use the network. Provider and
proxy environment variables are not inherited. Shell children are blocked;
guarded Node, read-only Git, and bundled esbuild remain available. Ungated live
tests can therefore fail offline; compare those identities rather than calling
providers or suppressing failures. This process guard is not an OS firewall or
a sandbox for hostile code; use it only with reviewed sources. Keep generated
reports/profile/data outside both source worktrees and out of Git. Temporary
probe test files must not enter the source tree's broad test-discovery glob.

Windows SQLite teardown can transiently return `ENOTEMPTY` after closing the
database. The migration-chain fixture retries only its temporary-directory
removal, with a bounded filesystem retry; assertions and Vitest retries remain
unchanged. Keep cleanup failures distinguishable from migration failures.

The inventory guard accepts Git checkout CRLF/LF differences but still rejects
stale content and unregistered source paths. CRG setup is separate fork tooling
([PR #33](https://github.com/azox-ai/azox-9router/pull/33)); preserve its pin and
data exclusions through upgrades. See [CODE_REVIEW_GRAPH.md](CODE_REVIEW_GRAPH.md).

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

Write both runs using the current isolated runner above, then compare their
JSON reports alongside the captured run-level evidence:

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

## v0.5.69 source-candidate worked example

The 2026-09-08 source candidate integrates upstream `v0.5.69` at
`eb712ca821f0ba6bc41043fbd14494c5af5daba5` into AZOX base
`9754c491500550cb4385212b98a0c3b6e2338fbe`. The inputs diverged from the
shared `v0.5.55` ancestor by 36 AZOX commits and 91 upstream commits. Merge
commit `05b9f25d2c1fe345d7d42e460de6bf71d95aec01` preserves both histories and
resolved 11 conflicted files; source hardening is recorded in
`24f817fd86f115a58eb1168ef8af499b634f7802`, followed by guarded-fetch test
alignment in `9a3025d434fb44ed297db7e582d2d2752deed727`.

The preservation pass kept the prior translator and session contracts and
added fail-closed SSRF/DNS and redirect controls, request-log redaction,
GitLab OAuth origin policy, project-ID/provider cancellation, combo quorum
cleanup, credential mutation guards, and ordered Antigravity attempt handling.
The concurrency regressions prove that late failures and late successes cannot
overwrite newer account state. The refreshed dependency graph reduced the
audit result to two moderate Monaco/DOMPurify findings; resolving them requires
a separate breaking dependency review rather than a forced audit update.

The final focused gate covers 49 files with 974 passing tests and two documented
expected failures. Independent matrices pass `150/150` and `87/87`, and static
parsing passes for all 47 source/test JavaScript files changed by the hardening
commit. The guarded candidate suite at source commit `9a3025d4` contains 2,820
tests: 2,726 pass, 63 inherited assertions fail, and 31 skip, with 3 collection,
4 suite, and 0 run errors. A detached `9754c491` baseline using the exact same
Node 20.20.2, Vitest 4.1.11, and candidate dependency graph through linked
dependency directories
contains 2,436 tests: 2,330 pass, 75 assertions fail, and 31 skip, with 4
collection, 6 suite, and 0 run errors. The identity comparator reports zero new
candidate failure and 14 reference failures absent from the candidate.

The production build passes in an isolated profile/data/npm-cache environment
and a fresh dist directory, followed by seven passing standalone loopback smoke
checks for health, models, contributor/admin authorization, and dashboard login
redirects. The Windows build records a non-fatal optional Tailscale trace-copy
warning; standalone startup and the checked routes pass. A first build that
inherited an inaccessible host npm-cache log failed `EPERM` and is superseded by
the isolated passing run. No live provider was called and no release image,
migration, publication, or deployment was performed. Keep the reports,
checksums, passing build log, superseded build log, and smoke JSON with the PR
evidence.

This candidate changes authentication and security boundaries, so its source
merge requires explicit Confirmation after the final evidence is attached.
That Confirmation approves only the reviewed source merge. Building or
publishing a release image and changing production remain Phase 6 work and
require a separate explicit rollout approval.

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

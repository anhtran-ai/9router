# Translation Layer Tests

Tests for `open-sse/translator/`. Goals: (1) data-driven coverage of every provider/model, (2) expose bugs caused by using OpenAI as the intermediate format.

## 1. Translation layer structure (`open-sse/translator/`)

Pipeline uses **OpenAI as the intermediate format**:
- Request: `source → openai → target` (`translateRequest`)
- Response (SSE chunk): `target → openai → source` (`translateResponse`)
- If `source === target` → translation is skipped (passthrough).

Components:
- `index.js` — `translateRequest` / `translateResponse` / `register(from, to, requestFn, responseFn)` / registry.
- `formats.js` — `FORMATS` enum (openai, claude, gemini, gemini-cli, openai-responses, antigravity, kiro, cursor, commandcode, ollama, vertex).
- `request/<from>-to-<to>.js` — one-way request translation.
- `response/<from>-to-<to>.js` — one-way SSE response translation.
- `schema/` — pure data enums (no logic): `roles.js` (ROLE, GEMINI_ROLE), `blocks.js` (OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM, valid-type lists), `finishReasons.js` (OPENAI_FINISH, CLAUDE_STOP, GEMINI_FINISH), `defaults.js` (MODEL_FALLBACK, DEFAULT_IMAGE_MIME). Import via `schema/index.js`.
- `concerns/` — cross-format translation LOGIC: `chunk.js`, `usage.js`, `reasoning.js`, `thinking.js` (effort↔budget/level), `toolCall.js`, `finishReason.js` (mapping fns), `image.js`, `json.js`.
- `formats/` — per-format logic: `openai.js` (filterToOpenAIFormat), `claude.js`, `gemini.js`, `responsesApi.js`, `maxTokens.js`.

**OpenAI-bridge pitfalls** (source of most bugs): going through OpenAI easily loses `thinking`/`reasoning`, image URLs (non-base64), `input_audio`, `is_error`; tool `id`/`index` become unstable (parallel tool calls), non-text system blocks, `tool_choice:"none"`.

## 2. Test layout

| File | Role |
|---|---|
| `matrix.js` | Reads `PROVIDER_MODELS` → builds matrix (alias, model, targetFormat, strip, upstreamId). DRY core. |
| `registerAll.js` | Imports every translator to run `register()` side-effects. **Required** (see §5). |
| `coverage-all-models.test.js` | Tier 1: every model translates without throwing; strip applied correctly. |
| `format-roundtrip.test.js` | Tier 2: tool id/system/parallel survive the bridge. |
| `bugs-openai-bridge.test.js` | Exposes concrete bugs (with source file:line). |

## 3. Running

Always pass `--config tests/vitest.config.js` (the alias config lives there; without it vitest may not resolve `@/...` subpaths).

```bash
# no-cred (default, offline): translator-only files
cd app && npx vitest run --config tests/vitest.config.js "tests/translator/"
cd app && npx vitest run --config tests/vitest.config.js "tests/translator/bugs-openai-bridge.test.js"

# real (calls live providers using credentials from the local DB)
cd app && RUN_REAL=1 npx vitest run --config tests/vitest.config.js "tests/translator/real/"
```
No-cred tests make NO network calls and need NO creds. Real tests (`real/`, gated by `RUN_REAL=1`) read active connections from `~/.9router/db/data.sqlite`, send a tiny prompt per provider through `handleChatCore`, and assert valid SSE. Account/quota errors (401/402/403/429) are treated as credential issues and skipped, not failures.

## 4. Adding a new provider → tests cover it AUTOMATICALLY

Add a provider by adding a key to `open-sse/config/providerModels.js` `PROVIDER_MODELS` (e.g. `newprov: [{ id, targetFormat?, strip?, upstreamModelId? }]`) plus its config in `open-sse/config/providers.js`.

→ `coverage-all-models.test.js` **automatically** runs for the new models with **no test edits**. `matrix.js` reads config directly.

Only add a dedicated test when a provider has a special format that does not round-trip cleanly (see §7).

## 5. `registerAll.js` — why it is required

`translator/index.js` uses `require(...)` (bundler-only) to lazy-load translators. Under vitest/ESM, `require` **silently no-ops** → empty registry → `translateRequest` skips the translation step → **false pass** (data is lost but the test goes green by mistake).

→ Every test calling `translateRequest`/`translateResponse` MUST `import "./registerAll.js"` at the top of the file.

## 6. Bug-exposure convention — `it.fails`

- A bug confirmed in the app but NOT yet fixed → use `it.fails(...)`.
- `it.fails` **passes while the app still has the bug**, **turns red once the bug is fixed** → a reminder to update the test (switch `it.fails` → `it` and confirm correct behavior).
- Pattern for a new bug-exposure test: real input → assert the "should-be-kept" behavior → wrap in `it.fails` + a comment with the source `file:line`.

## 7. Special formats to watch

- `kiro` (binary AWS EventStream), `cursor` (protobuf ConnectRPC), `commandcode` (NDJSON) → responses do NOT round-trip cleanly through openai; test via their executors, not just the translator.
- Single-provider-two-formats (most fragile): `opencode-go` (minimax models → claude, others openai), `github` (escalates `/chat/completions` → `/responses` at runtime), `xiaomi-tokenplan` (claude alias).
- `gemini`/`gemini-cli`: system and developer messages are collected into ordered `systemInstruction.parts`.

## 8. Current known bugs and boundary policies

There are currently no executable `it.fails` cases in `tests/translator/`.
Every former expected-fail case now has a normal passing regression.

**Lossless repairs**

| Boundary | Guaranteed behavior |
|---|---|
| Claude → OpenAI | Remote image URLs and ordinary thinking text survive; tool errors become explicit `[Tool error]` content. |
| OpenAI → Claude | `reasoning_content` becomes thinking; Claude Code identity is injected only for provider `claude`. |
| Chat → Responses | Every system/developer message is retained in ordered `instructions`. |
| Responses → Chat | Nameless calls cannot create `tool_calls: []`; valid image URLs remain image URLs. |
| OpenAI → Gemini | All system/developer instructions and empty-string tool results survive; tool-id maps are prototype-safe. |
| OpenAI → Cursor/Kiro | Client `max_tokens` is retained. |
| OpenAI/Claude → Ollama | Assistant reasoning text is retained as native `message.thinking`, including reasoning-only and tool-call turns. |

**Fail-closed policies**

All rows throw `ToolCompatibilityError` (`400`, code `unsupported_tool_constraint`)
instead of silently dropping or reinterpreting input.

| Boundary | Reason |
|---|---|
| Responses `input_image.file_id` / `input_file.file_id` → Chat | Chat targets have no generic OpenAI file resolver/upload equivalent; a file id is not transferable content. Inline file data remains lossless. |
| Claude `redacted_thinking` → Chat | Chat has no lossless encrypted-thinking representation. |
| Claude image inside `tool_result` → Chat | Chat tool-result content cannot carry the Claude image block losslessly. |
| OpenAI `input_audio` → Claude Messages | Claude Messages has no audio input block. |
| OpenAI rich media → Cursor | The implemented Cursor protobuf transport is text-only. |
| OpenAI rich media → CommandCode | The verified `/alpha/generate` request schema exposes text/tool blocks only. |
| OpenAI audio/file → Kiro | The Kiro conversation transport implemented here exposes text, tools, and inline images only. |
| Remote image still present at Kiro translation | Kiro requires inline base64; chatCore must prefetch the URL first. |
| Malformed tool arguments → Kiro/CommandCode | Replacing invalid JSON with `{}` can invoke a tool with different arguments. |
| OpenAI/Claude reasoning history → Cursor/CommandCode/Kiro | These request transports have no assistant-history field/block that can carry reasoning without exposing it as visible text. |

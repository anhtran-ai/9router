# Agent instructions

This repository is the canonical Azox-maintained 9Router codebase.

## Mandatory session bootstrap

Before planning or changing this repository, read the latest `main` version of:

1. `azox-ai/azox-knowledge/MASTER_AGENT.md`
2. `azox-ai/azox-knowledge/MEMORY.md`
3. `azox-ai/azox-knowledge/agent-guidance/session-start.md`

If canonical knowledge is unavailable, limit work to reversible discovery and
report the missing context.

Before changing code:

1. Read `CLAUDE.md` for repository-specific commands and architecture guidance.
2. Read `docs/ARCHITECTURE.md` before changing system boundaries.
3. Read `open-sse/AGENTS.md` before changing the routing or translation engine.
4. Read relevant shared policy in `azox-ai/azox-knowledge`.
5. Confirm the issue has objective acceptance criteria and a risk level.

Preserve upstream attribution and the MIT license. Never commit provider
credentials, OAuth tokens, local databases, or generated runtime state.

The test suite has a documented regression baseline and is not expected to be
fully green on a plain checkout. Report baseline comparison evidence rather
than hiding failures or retrying them into acceptance.

Publishing packages, container images, documentation, or releases requires
explicit human approval.

# Code Review Graph

9Router pins local Code Review Graph (CRG) `v2.3.7`, following Knowledge
[ADR-0003](https://github.com/azox-ai/azox-knowledge/blob/main/decisions/ADR-0003-code-review-graph.md).
Git, source, and tests remain authoritative; the graph is derived.

## Setup and use

Prerequisites: Python 3.11+ and `uvx` on PATH. The reviewed launcher version is
`uv==0.12.1` (`python -m pip install --user uv==0.12.1` if not installed).
From the repository root (use `py -3` on Windows or `python3` on POSIX):

```sh
python scripts/crg.py build
python scripts/crg.py status
python scripts/crg.py search normalizeCodexTools
python scripts/crg.py impact --files open-sse/executors/codex.js
```

Build before non-trivial source work and after large changes. Use the graph
first for callers, dependencies, flows, and impact, then confirm against source
and tests. For single-symbol lookups use `rg`; if CRG is unavailable, unsupported,
or fails, record the failure and use targeted source reads.

`.mcp.json` and `.codex/config.toml` launch the same pinned local server. Restart
the coding client after setup; Codex loads project configuration only for a
trusted repository. Run `/mcp` to verify the connection. The CLI can be used
without restarting the client.

## Data boundary and upgrades

Embeddings are not installed or enabled. `.code-review-graphignore` excludes
restricted paths, credentials, runtime data, dependencies, and generated output.
Do not weaken exclusions, enable external embeddings, or register cross-repo
search without the approvals required by Knowledge. Never commit the generated
`.code-review-graph/` directory or graph exports.

Keep this setup as fork tooling during upstream upgrades; review a pinned CRG
version change separately. If upstream adopts equivalent tooling, consolidate
the launchers while preserving the local-only and exclusion requirements.

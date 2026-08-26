#!/usr/bin/env python3
"""Run the repository-pinned Code Review Graph CLI through uvx."""

from __future__ import annotations

import shutil
import site
import subprocess
import sys
from pathlib import Path


CRG_TOOL = "code-review-graph@2.3.7"
REPO_ROOT = Path(__file__).resolve().parents[1]
REPO_COMMANDS = {
    "architecture",
    "build",
    "detect-changes",
    "impact",
    "query",
    "search",
    "serve",
    "status",
    "update",
}


def find_uvx() -> str:
    found = shutil.which("uvx")
    if found:
        return found

    user_base = Path(site.getuserbase())
    if sys.platform == "win32":
        candidate = (
            user_base
            / f"Python{sys.version_info.major}{sys.version_info.minor}"
            / "Scripts"
            / "uvx.exe"
        )
    else:
        candidate = user_base / "bin" / "uvx"
    if candidate.is_file():
        return str(candidate)

    raise SystemExit(
        "uvx is required. Install the reviewed launcher first: "
        f"{sys.executable} -m pip install --user uv==0.12.1"
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] not in REPO_COMMANDS:
        allowed = ", ".join(sorted(REPO_COMMANDS))
        raise SystemExit(f"usage: python scripts/crg.py <command> [args]\ncommands: {allowed}")

    command = [find_uvx(), CRG_TOOL, args[0], *args[1:], "--repo", str(REPO_ROOT)]
    return subprocess.run(command, cwd=REPO_ROOT, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())

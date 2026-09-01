#!/usr/bin/env python3
"""Validate generated World Money relationship data."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]")
REQUIRED_DIRECTORIES = (
    "00-MOC",
    "10-Countries",
    "20-Central-Banks",
    "30-Payment-Rails",
    "40-Currencies",
)


def validate(vault_path: Path) -> list[str]:
    errors: list[str] = []
    if not vault_path.is_dir():
        return [f"vault directory does not exist: {vault_path}"]

    for directory in REQUIRED_DIRECTORIES:
        if not (vault_path / directory).is_dir():
            errors.append(f"missing required directory: {directory}")

    notes = sorted(vault_path.rglob("*.md"))
    if not notes:
        return errors + ["vault contains no markdown notes"]

    names = {note.stem for note in notes}
    for note in notes:
        relative = note.relative_to(vault_path)
        text = note.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            errors.append(f"{relative}: missing YAML frontmatter opening delimiter")
        else:
            closing = text.find("\n---\n", 4)
            if closing == -1:
                errors.append(f"{relative}: missing YAML frontmatter closing delimiter")

        if text.count("```") != text.count("```dataview") * 2:
            errors.append(f"{relative}: unbalanced Dataview code block")

        for match in WIKILINK_RE.finditer(text):
            target = match.group(1).strip()
            if target and target not in names:
                errors.append(f"{relative}: unresolved wikilink [[{target}]]")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a World Money generated vault")
    parser.add_argument("vault_path", type=Path)
    args = parser.parse_args()
    errors = validate(args.vault_path)
    if errors:
        print("Vault validation failed:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print(f"Vault validation passed: {args.vault_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

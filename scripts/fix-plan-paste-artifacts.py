#!/usr/bin/env python3
"""
fix-plan-paste-artifacts.py

Repair paste-artifact backtick patterns in CorePrt-plan-2026-07-29.md
and docs/2026-07-29-launch.md.

When the original plan was pasted from chat into a markdown file, two
lines lost their opening backtick pairs:

  - Line 57: ``Public key: [REDACTED] and ``Secret key: [REDACTED]``
    (was broken: missing closing `` before " I cannot do this step...")
  - Line 189: ``Public key: [REDACTED] and ``Secret key: [REDACTED]``
    (was broken: missing closing `` before " and ``")

This script finds those broken byte sequences and replaces them with
correct inline-code formatting. Idempotent — running twice is safe.

Usage:
  python3 scripts/fix-plan-paste-artifacts.py
  python3 scripts/fix-plan-paste-artifacts.py --check   # exit non-zero if broken

The script operates on byte-level patterns because Markdown rendering
of adjacent backticks is ambiguous; treating them as raw bytes avoids
the visual ambiguity that defeated earlier text-level edits.
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TARGETS = [
    REPO_ROOT / "CorePrt-plan-2026-07-29.md",
    REPO_ROOT / "docs" / "2026-07-29-launch.md",
]

# Each entry: (broken_bytes, fixed_bytes)
# Found via hex dump; constructed with explicit \x60 escapes to avoid
# Python string-escape ambiguity around backticks.
FIXES = [
    # Line 57 — single backticks → double pairs; restore missing ")" before ". I cannot..."
    # broken (paste artifact):
    #   which read `Public key: [REDACTED] and `Secret key: [REDACTED] I cannot do this step for you.
    # fixed (correct markdown inline code):
    #   which read ``Public key: [REDACTED]`` and ``Secret key: [REDACTED]``). I cannot do this step for you.
    (
        b"which read \x60Public key: [REDACTED] and \x60"
        b"Secret key: [REDACTED] I cannot do this step for you.",
        b"which read \x60\x60Public key: [REDACTED]\x60\x60 and \x60\x60"
        b"Secret key: [REDACTED]\x60\x60). I cannot do this step for you.",
    ),
    # Line 189 — single backticks → double pairs around both [REDACTED] segments
    # broken (paste artifact):
    #   literally read `Public key: [REDACTED] and `Secret key: [REDACTED] |
    # fixed (correct markdown inline code):
    #   literally read ``Public key: [REDACTED]`` and ``Secret key: [REDACTED]`` |
    (
        b"literally read \x60Public key: [REDACTED] and \x60"
        b"Secret key: [REDACTED] |",
        b"literally read \x60\x60Public key: [REDACTED]\x60\x60 and \x60\x60"
        b"Secret key: [REDACTED]\x60\x60 |",
    ),
]


def main() -> int:
    check_only = "--check" in sys.argv
    total_replacements = 0
    any_broken = False

    for path in TARGETS:
        if not path.exists():
            print(f"skip: {path} (does not exist)", file=sys.stderr)
            continue

        raw = path.read_bytes()
        original = raw
        file_replacements = 0

        for broken, fixed in FIXES:
            count = raw.count(broken)
            if count == 0:
                continue
            if check_only:
                any_broken = True
                print(f"broken: {path} ({count} occurrence(s))", file=sys.stderr)
                continue
            raw = raw.replace(broken, fixed)
            file_replacements += count

        if raw != original:
            if check_only:
                continue
            path.write_bytes(raw)
            print(f"fixed:  {path} ({file_replacements} replacement(s))")
            total_replacements += file_replacements
        else:
            print(f"clean:  {path}")

    if check_only:
        return 1 if any_broken else 0

    print(f"\ntotal: {total_replacements} replacement(s) across {len(TARGETS)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

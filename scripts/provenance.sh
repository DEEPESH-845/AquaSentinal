#!/usr/bin/env bash
# Per-file provenance of every tracked file against the HydraLoom source commit.
# Usage: scripts/provenance.sh [path-to-HydraLoom-checkout]   (default ../reference/HydraLoom)
# Writes docs/evidence/provenance.tsv: path, origin (IDENTICAL | MODIFIED | NEW), lines added, lines removed, source lines.
# IDENTICAL and MODIFIED files exist at the same path in HydraLoom; NEW files do not. A MODIFIED file is not automatically
# hackathon work in full: read docs/HACKATHON_CONTRIBUTIONS.md for what changed inside it.
set -euo pipefail
SRC="${1:-../reference/HydraLoom}"
EXPECTED=d59308e17ff483a54512bc340f6351e779fb26e7
cd "$(dirname "$0")/.."
actual=$(git -C "$SRC" rev-parse HEAD)
[ "$actual" = "$EXPECTED" ] || { echo "HydraLoom checkout is at $actual, expected $EXPECTED" >&2; exit 1; }
out=docs/evidence/provenance.tsv
mkdir -p docs/evidence
printf 'path\torigin\tadded\tremoved\tsource_lines\n' > "$out"
git ls-files | grep -v '^docs/evidence/provenance.tsv$' | while read -r f; do
  if [ -f "$SRC/$f" ]; then
    if cmp -s "$SRC/$f" "$f"; then
      printf '%s\tIDENTICAL\t0\t0\t%s\n' "$f" "$(wc -l < "$SRC/$f" | tr -d ' ')"
    else
      read -r a r _ < <(git diff --no-index --numstat "$SRC/$f" "$f" || true)
      printf '%s\tMODIFIED\t%s\t%s\t%s\n' "$f" "$a" "$r" "$(wc -l < "$SRC/$f" | tr -d ' ')"
    fi
  else
    printf '%s\tNEW\t%s\t0\t0\n' "$f" "$( (wc -l < "$f" 2>/dev/null || echo 0) | tr -d ' ')"
  fi
done >> "$out"
awk -F'\t' 'NR>1{n[$2]++} END{for(k in n) printf "%s %d\n", k, n[k]}' "$out" | sort
echo "wrote $out"

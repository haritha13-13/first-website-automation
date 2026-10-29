#!/usr/bin/env bash
# Syntax-check all project files without running them.
set -u
cd "$(dirname "$0")/.."

fail=0
while IFS= read -r f; do
  if ! node --check "$f" 2>&1 | sed "s|^|  [syntax] $f: |"; then
    fail=1
  fi
done < <(find src scripts -name '*.js' -o -name '*.mjs' 2>/dev/null | sort)

if [ "$fail" -eq 0 ]; then
  echo "All files OK"
else
  echo "Syntax errors found"; exit 1
fi
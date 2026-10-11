#!/usr/bin/env bash
# Checks a report written from assets/report-template.md: it is REPORT.md in the current directory, has every section,
# and has no template placeholders left. Prints the problems and exits 1, or prints "ok".
set -uo pipefail

report="REPORT.md"
problems=()

if [ ! -f "$report" ]; then
  echo "missing: write the report to $(pwd)/$report"
  exit 1
fi

for heading in "## Layout" "## Languages" "## Activity" "## Where to start reading"; do
  grep -qx "$heading" "$report" || problems+=("missing section: $heading")
done

head -1 "$report" | grep -qE '^# [^<]+/[^>]+$' || problems+=("first line must be '# <owner>/<name>' with the real names")

# Template placeholders look like <one line, from looking at it>; HTML-like tags in prose are rare in a report.
while IFS= read -r line; do
  problems+=("placeholder left: $line")
done < <(grep -nE '<[A-Za-z][^>]*>' "$report")

grep -qE '!\[' "$report" && problems+=("images are not allowed")

if [ ${#problems[@]} -gt 0 ]; then
  printf '%s\n' "${problems[@]}"
  exit 1
fi
echo ok

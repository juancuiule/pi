#!/usr/bin/env bash
# Checks that a note was saved from Mousepad: a Mousepad window shows the file with no unsaved changes (its title has
# no leading "*"), and the file exists. Prints the file's contents and "ok", or the problem and exits 1.
# Usage: check-note.sh /workspace/<name>
set -uo pipefail

file="${1:?usage: check-note.sh /workspace/<name>}"
titles=$(xdotool search --onlyvisible --class mousepad getwindowname %@ 2>/dev/null || true)

if ! printf '%s\n' "$titles" | grep -qF -- "$file - Mousepad"; then
  echo "no Mousepad window has $file open; open it with: mousepad $file &"
  echo "Mousepad windows: ${titles:-none}"
  exit 1
fi
if printf '%s\n' "$titles" | grep -qxF -- "*$file - Mousepad"; then
  echo "unsaved changes in Mousepad: press ctrl+s in its window"
  exit 1
fi
if [ ! -f "$file" ]; then
  echo "$file does not exist yet: press ctrl+s in the Mousepad window"
  exit 1
fi
echo "--- $file"
cat "$file"
echo
echo "--- ok"

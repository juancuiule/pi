#!/usr/bin/env bash
# Facts about a cloned repository, as JSON: languages by file count, largest top-level directories, manifests,
# and recent commit activity. Usage: repo-stats.sh <repository directory>
set -euo pipefail

dir="${1:?usage: repo-stats.sh <repository directory>}"
cd "$dir"

files=$(git ls-files)

languages=$(printf '%s\n' "$files" |
  awk -F/ '$NF !~ /^\./ { print $NF }' |
  sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p' |
  sort | uniq -c | sort -rn | head -10 |
  jq -R -s 'split("\n") | map(select(length > 0) | capture("^ *(?<files>[0-9]+) (?<extension>.+)$") | .files |= tonumber)')

directories=$(printf '%s\n' "$files" |
  awk -F/ 'NF > 1 { print $1 }' |
  sort | uniq -c | sort -rn | head -8 |
  jq -R -s 'split("\n") | map(select(length > 0) | capture("^ *(?<files>[0-9]+) (?<directory>.+)$") | .files |= tonumber)')

manifests=$(printf '%s\n' "$files" |
  grep -E '(^|/)(package\.json|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Gemfile|composer\.json)$' |
  head -20 | jq -R -s 'split("\n") | map(select(length > 0))')

jq -n \
  --arg remote "$(git remote get-url origin)" \
  --argjson files "$(printf '%s\n' "$files" | wc -l | tr -d ' ')" \
  --argjson languages "$languages" \
  --argjson directories "$directories" \
  --argjson manifests "$manifests" \
  --arg latest "$(git log -1 --format=%cI)" \
  --arg oldest_fetched "$(git log --reverse --format=%cI | head -1)" \
  --argjson commits_fetched "$(git rev-list --count HEAD)" \
  --argjson authors "$(git log --format=%an | sort -u | wc -l | tr -d ' ')" \
  --argjson recent "$(git log -5 --format='%h%x09%cs%x09%s' | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {hash: .[0], date: .[1], subject: .[2]})')" \
  '{remote: $remote, files: $files, languages: $languages, largest_directories: $directories, manifests: $manifests,
    activity: {latest_commit: $latest, oldest_fetched_commit: $oldest_fetched, commits_fetched: $commits_fetched,
      authors_in_fetched_commits: $authors, recent_commits: $recent}}'

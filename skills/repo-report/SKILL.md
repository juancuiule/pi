---
name: repo-report
description: Clone a public GitHub repository and write a short report on what it is, how it is organized and how active it is. Use when the user gives a GitHub repository (URL or owner/name) and wants an overview of it.
compatibility: Needs a shell sandbox with git and network access.
---

# Repository report

You need the bash tool; if you do not have it, tell the user to start the conversation with a shell sandbox.

1. Clone the repository shallowly into the working directory (100 commits are enough for the activity section):

   ```bash
   git clone --depth 100 https://github.com/<owner>/<name>.git repo
   ```

2. Run the bundled script, which prints the facts the report needs as JSON:

   ```bash
   .skills/repo-report/scripts/repo-stats.sh repo
   ```

3. Read the repository's README, and skim the entry points the stats point to (the largest directories, manifest files such as `package.json`, `pyproject.toml` or `Cargo.toml`).

4. Load `assets/report-template.md` with the skill tool and write the report to `REPORT.md` following it. Every number in the report must come from the script's output; do not estimate.

5. Answer with the report's summary paragraph and say that the full report is in `REPORT.md`.

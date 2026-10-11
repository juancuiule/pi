---
name: repo-report
description: Clone a public GitHub repository and write a short report on what it is, how it is organized and how active it is. Use when the user gives a GitHub repository (URL or owner/name) and wants an overview of it.
compatibility: Needs a shell sandbox with git and network access.
---

# Repository report

You need the bash tool; if you do not have it, tell the user to start the conversation with a shell sandbox and stop.

## Rule: only checked facts

Every statement in the report and the answer must come from the stats JSON, the README lines you read, or a file you opened. Do not estimate counts, sizes, dates or release frequency, and do not describe files you did not open. When the stats do not cover something, leave it out.

## Steps

Run every command from the working directory, without `cd`. Run this skill's scripts by the full path the skill tool gave you for its folder; below, `<skill folder>` stands for that path.

1. Clone shallowly into `repo` in the working directory:

   ```bash
   git clone --quiet --depth 100 https://github.com/<owner>/<name>.git repo
   ```

2. Get the facts:

   ```bash
   <skill folder>/scripts/repo-stats.sh repo
   ```

   Keep the JSON: `readme`, `languages`, `largest_directories`, `manifests`, `recent_tags` and `activity` are the report's sources.

3. Read the first 80 lines of the README the stats name, not the whole file:

   ```bash
   head -80 repo/<readme.path>
   ```

   If `readme` is null, say the repository has no README.

4. Open the main manifest from `manifests` (for example `repo/package.json`), and list the largest directory to see what it holds. Two or three commands are enough.

5. Load `assets/report-template.md` with the skill tool. Write the report to `REPORT.md` in the working directory, exactly that path, replacing every `<placeholder>`. No images, no links to local files.

6. Check it, fix what it reports and check again until it prints `ok`:

   ```bash
   <skill folder>/scripts/check-report.sh
   ```

7. Answer with two things only: the report's summary paragraph, then the line `Full report: REPORT.md`.

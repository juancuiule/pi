# just-bash for Level `none`: findings and a design (#93)

Question: can a Conversation at Level `none` get durable files, and maybe a `bash`, without a Sandbox and without claiming Capacity? This looks at Vercel's [just-bash](https://github.com/vercel-labs/just-bash) (npm `just-bash`, 3.6.0, Apache-2.0) and at how [vercel-labs/durable-harness](https://github.com/vercel-labs/durable-harness)'s `pi-world` package already builds a virtual workspace for pi-durable. Read 2026-11-03.

**Recommendation.** Do it in two steps. First ship a **files-only virtual workspace** for `none`: pi-durable's own `read`/`write`/`edit` (no `bash`) over a small in-memory file tree whose changes ride on each tool result, folded per Seat, materialized into the Workspace on an Upgrade to `shell`. Then, only if traces show agents at `none` asking for a shell, add just-bash as `bash` in a **worker thread pool** with hard caps. just-bash is good enough for the second step but not for running on the server's main thread.

## 1. What just-bash is

A bash interpreter written in TypeScript: parser, AST interpreter, and about 80 commands reimplemented in JS (coreutils, `grep`/`rg`, `sed`, `awk`, `jq`, `yq`, `xan`, `sqlite3` via sql.js, `tar`/`gzip`, `diff`). No process is ever spawned.

- **Filesystems.** `InMemoryFs` (default), `OverlayFs` (copy-on-write over a real directory), `ReadWriteFs` (a real directory), `MountableFs` (compose them). Files can be lazy (a function called on first read). The shell state (variables, functions, cwd) resets every `exec()`; the filesystem is shared across calls.
- **Opt-in surface.** `curl` exists only when `network` is configured (URL-prefix and method allow-lists, header injection at the fetch boundary, redirects re-checked). `python3` (CPython on WASM) and `js-exec` (QuickJS on WASM, 64 MB) are off by default.
- **Limits** (`executionLimits`, profiles `normal` and `hardened`): call depth, command count (100k), source bytes, retained filesystem bytes, output bytes, archive bytes, SQLite bytes, wall-clock deadline (30 s), cancellation grace. Every `exec` takes an `AbortSignal`, honoured at statement boundaries.
- **Security model, in its own words:** "All execution happens without VM isolation." It defends against prototype pollution and host-realm escapes with scoped proxies (best effort) and says to use an isolated worker or process "when complete protection and reversible host state are both required". Worker `resourceLimits` do not cap the WASM memory of CPython or sql.js.
- **Footprint.** 101 MB of `node_modules` with its dependencies (sql.js, the CPython WASM in `vendor/`, TypeScript, turndown, file-type...).

## 2. Measurements

One run, Node 26.13, i7-8700K, in process (no worker), on a machine also running other test suites; a 500-file, 100k-line tree in `InMemoryFs`.

| Script | Time |
| --- | --- |
| `import("just-bash")` | 205 ms |
| `new Bash({ files })` with 500 files | 142 ms |
| `echo hi` | 36 ms (first exec) |
| `grep -r TODO src \| wc -l` | 303 ms |
| `cat src/*.txt \| awk '{print $3}' \| sort \| uniq -c` (100k lines) | 1,718 ms |
| `jq '.a \| add'` | 13 ms |
| a 10,000-iteration `while` loop | 599 ms |
| `seq 1 50000 > big.txt && sed -n 49999p big.txt` | 71 ms |
| `while true; do :; done` | stopped at 100k commands, exit 126, 715 ms |
| `curl`, `node`, `python3` | `command not found` (127) |
| `cat /etc/passwd; ls /` | no such file; `/` holds only `bin dev proc usr workspace` |
| `sqlite3 :memory: "select 1+1"` | 56 ms |

Process RSS after the run: 205 MB. Takeaways: correct and contained, but 10–100x slower than real coreutils, and every millisecond above is the server's event loop when it runs in process: a 1.7 s `awk | sort` would stall every SSE stream and request of every User. A worker thread is not optional.

## 3. How durable-harness does it (`packages/pi-world`)

`virtualEnv()` gives pi-durable an `ExecutionEnv` (`env.ts`, `MachineEnv`) over a "workspace machine": just-bash on an in-memory filesystem, in a worker leased to the session.

- pi-durable builds an env per `EnvTarget` (conversation + reader), which cannot tell which tool call it serves. So pi-world does not commit from env operations: it **wraps** pi-durable's own `CodingTools` (`workspace.ts`, `bindTool`). Each call runs on a view of the committed files; what it changed comes back as `details["hw.workspace"]` of its `pi.tool-result` entry, in the **same commit as the result**. A crash before the result changed nothing, so every file tool is replay-safe; a call the machine cut off (time limit, worker gone) is rolled back and fails saying so.
- The session's files are the **fold** of every result's delta in commit order (`files.ts`, `SessionFiles`): a file of at most 4 KB inline (text or base64), larger ones by SHA-256 in a blob stream written before the result that names them; at most 32 KB inline per call; `null` removes.
- Outside the wrapped tools the workspace is read-only. A scratch variant (`durable: false`) keeps files in memory for one turn and tells the model with a note.

That answers #93's atomicity question: the seam is the tool result, not the env.

## 4. Design for effect-pi

### Step 1: files-only virtual workspace at `none`

- **Storage.** Deltas ride on `pi.tool-result` `details` (`ep.workspace`), files ≤ 4 KB inline, larger ones as blobs in `ObjectStore` under a `workspace-blobs` bucket keyed `<conversation>/<sha256>` (S3 in production, `memory()` in tests). Limits: 500 files, 10 MB total, 1 MB per file, 32 KB inline per call; over a limit the write fails with a message the model reads.
- **Fold.** One `SessionFiles` per Seat, built on `Agents.open` by scanning the conversation's `pi.tool-result` entries (`tx.scanEntries`, ascending), then kept current from `harness.subscribeCommits` (or `watchEvents`). Rebuilt, never stored: the transcript is the source of truth, so a fork inherits the files at the fork entry for free.
- **Tools.** `extensionsFor("none")` returns a `virtual-files` extension: pi-durable's `read`, `write`, `edit` (and `ls`/`find`/`grep` read-only helpers if wanted), each wrapped like `bindTool`: run against a copy-on-write view of the fold, return the result with its delta. No `bash`. Not gated by `withApproval`: nothing outside the conversation is touched.
- **Env.** The `env` builder in `Agents.layer` returns a read-only `ExecutionEnv` over the fold when `SandboxDoc` has no sandbox and the Level is `none`, so pi-durable's own tool code works unchanged; writes outside the wrapped tools fail.
- **Console.** The Files tab reads the fold (`GET /conversations/:id/files/tree` already exists; a `none` branch serves the fold) instead of "no sandbox".
- **Skills.** `.skills/<name>/` could be installed into the fold as well, so skill scripts are readable at `none` (not runnable without a shell).
- **Subagents.** A child at `none` has no Sandbox and follows its owner (`SandboxDoc.owner`); it should fold its _owner's_ files plus its own results, and write to its own transcript. Simplest correct rule for v1: children at `none` read the parent's fold and write their own deltas, which the parent's fold does not see until the `task` result comes back. Alternatively, disable writes in children at `none`.
- **Archive.** Deltas are transcript state and stay; Archive deletes the conversation's blob prefix and marks the files gone (the fold skips results before the archive marker).

### Step 2: just-bash as `bash` at `none`

- **Where it runs.** A small pool of `worker_threads` (2 by default, `VIRTUAL_SHELL_WORKERS`), each with `resourceLimits` (heap 256 MB) and a hard wall clock: just-bash's `maxExecutionTimeMs` (10 s, the `hardened` profile) plus `worker.terminate()` after a grace period, so a stuck command never holds the event loop or the worker. Python and `js-exec` stay off (their WASM memory is not capped by worker limits); network stays off (web search is the agent's network).
- **A call.** The tool sends the call's view of the fold (paths + bytes, or lazy reads over a `MessagePort`) to a leased worker, runs `bash.exec(command, { signal })`, gets back stdout/stderr/exit and the filesystem diff, which becomes the result's delta exactly like a file tool. A terminated worker means the call changed nothing.
- **Cost.** Spin-up is about 350 ms (import + construct), so workers are kept warm and reused; a call costs the copy of the touched files plus the command.
- **Prompt.** The `workspace` section tells the agent at `none` that `bash` is a restricted shell: no network, no real binaries, no `python`, `node`, package managers, and that an Upgrade gets a real one.

### Upgrade `none` → `shell`

Materialize the fold into the new Workspace: after `workspaces.sandbox` creates the Sandbox and before `SandboxDoc` is recorded, write every folded file into `/workspace` through the new Sandbox's `ExecutionEnv` (`appendFile` per file, blobs streamed from `ObjectStore`), the same place skills and attachments are copied today. Then record an `app.settings`-style entry ("files moved to the shell"), so later results stop carrying deltas and the fold is frozen. A failure aborts the Upgrade, keeping the Level at `none` and the fold intact, rather than starting a shell with half the files.

## 5. Open questions

- Is a restricted shell at `none` worth 100 MB of dependencies and a worker pool, or is "Upgrade to get a shell" enough? Step 1 alone covers the common case (the agent writing notes, drafts and data files it reads back).
- Should the fold be cached in SQLite beside the transcript for long conversations, instead of rescanning results on every Seat open?
- Do children at `none` write at all, given they share the parent's files at higher Levels?

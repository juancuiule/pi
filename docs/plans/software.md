# Software

Lets the person choose what is installed in a conversation's Sandboxes beyond the Level's image: Node.js, uv, Python's data science libraries, ImageMagick, FFmpeg, Google Chrome. Issue [#21](https://github.com/juancuiule/pi/issues/21). Terms are defined in [GLOSSARY.md](../../GLOSSARY.md).

## Decisions

- **Software** is the term, in the console and in code. "Tools" already means the agent's tools (`disabledTools`, the Capabilities sheet), and "packages" means apt packages.
- The catalog is a table in `src/sandbox/software.ts`: per entry a label, a description, the lowest Level that offers it, the shell commands that install it (one image layer), and what the agent is told. Chrome is offered from `desktop` up; the others from `shell` up. Chrome's entry installs the amd64 package, so it is offered only on x64 hosts.
- `WorkspaceDoc` records `software` beside the Level, in catalog order. Like the Level it only grows: an Upgrade raises the Level, adds software, or both, and keeps what was there. Adding software to a running conversation is an Upgrade at the same Level: a new Sandbox over the same files, the old one removed.
- Images are layered and built on demand: `FROM` the Level's image, then one `RUN` layer per selected entry in catalog order, tagged by a hash of the base image's id and that Dockerfile. A selection reuses the tag when it exists; Docker's layer cache also shares the layers of a common prefix between selections. A rebuilt base image changes the hash, so stale images are never used. Builds are serialized, so two Seats asking for the same image build it once. The images carry the label `effect-pi.software` so they can be pruned.
- The agent is told what is installed in the `workspace` prompt section.
- The person chooses: at create (the new conversation's Environment), and with Upgrade (the conversation header's menu). The agent's `upgrade_workspace` does not take software yet.

## Measurements

The prototype (`docker build` over `effect-pi/sandbox-shell`, Docker Desktop 29.4 on an Intel Mac) timed three ways to get each entry into a shell Sandbox. "Install at start" is running the same commands in a new container, which every Seat would pay.

First, the strategy, with the first catalog draft (Python was then apt's pip and venv):

| Entry | First build | Start, image built | Install at start | Image |
| --- | --- | --- | --- | --- |
| none (base) |  | 1.4s |  |  |
| Node.js | 72.8s | 5.7s | 75.1s | 129MB |
| Python pip and venv | 36.4s | 1.0s | 21.2s | 80MB |
| Google Chrome | 142.6s | 1.0s | 69.2s | 388MB |

Node and Python together, after Node alone was built: 19.5s, so a shared prefix is not built again.

Then the catalog: each entry built over the shell image and checked by running what it installs.

| Entry | Build | Layer | Checked |
| --- | --- | --- | --- |
| Node.js 24, with pnpm and yarn | 17.3s | 58MB | `node`, `npm`, `pnpm`, `yarn` |
| uv | 9.0s | 22MB | `uv venv`, `uv pip install` |
| Python data science, through uv | 46.4s | 111MB | imports; `pip install` system-wide; a `uv venv --system-site-packages` sees pandas |
| ImageMagick | 36.0s | 31MB | `convert`, `identify` |
| FFmpeg | 92.5s | 166MB | `ffmpeg -version` |

Data science through apt instead took 84.1s for 157MB, with pandas 2.1.4 and numpy 1.26.4 (through uv: pandas 3.0.6, numpy 2.5.4), and Ubuntu refused `pip install` outside a venv. Through uv, the entry removes the `EXTERNALLY-MANAGED` marker so `pip install` works in the Sandbox, where nothing else manages the system Python. Pandoc with LibreOffice (122.0s, 212MB) was checked and left out; so was Blender (a CPU renderer here, and Ubuntu's 4.0). One run each, on a home connection: downloads dominate (Node's install at start takes as long as its build), so the absolute times will vary; the shape will not. Once an image exists a Sandbox starts as fast as the base, while installing at start costs every Seat that time again. The first build costs one to two installs, once per selection. Layered images win; the first conversation with a new selection waits for its build, and the console says so.

## Verification

- `pnpm check` and `pnpm test:docker`; the Docker test builds `["uv"]`, runs `uv --version`, and checks that a second Sandbox reuses the image.
- The console, driven with Playwright against `pnpm dev`: a shell conversation created with uv, then ImageMagick added from Upgrade's "Add software…" (34.6s, a first build); `uv --version` and `convert -version` both run in the replaced Sandbox. A create that built Node.js and FFmpeg took about 90s, with the console saying why.
- Two bugs found that way and fixed: a same-Level Upgrade claimed a second `shell` while holding one, so at the limit adding Software failed with the conversation itself as the holder; and the sidebar listed a slow create twice, because the create's result was appended to a list that already held it.

## Open

- Building common selections ahead of time, so no person waits minutes on a first build.
- Pruning images whose base was rebuilt (`docker image prune --filter label=effect-pi.software`).
- The agent asking for software through `upgrade_workspace`.
- A build fails with a `SandboxError`, which the API answers with a 500, so the console shows a generic error instead of the build's message. Offline builds of an uncached selection fail.
- While the image builds, the new conversation is listed as paused: it is stored, but has no Seat yet.
- A create waits for its build; building in the background with a "preparing" state would free the request.

# Base images carry Python packaging and common CLI tools; a missing command says how to get it

A conversation asked for a summary of a YouTube video. The agent upgraded to a shell and needed `yt-dlp`. It spent five turns on `pip` (not installed), `python3 -m pip` (no module), and `apt-get install python3-pip` ("Unable to locate package": the image deletes apt's package lists). Three gaps caused this: the shell image had `python3` with no way to install packages, the agent was not told what the machine has, and "command not found" said nothing about what to do next.

## Decisions

- **uv and a working pip are in the shell image**, so every desktop has them too. `pip install` works system-wide as root: the image removes Ubuntu's `EXTERNALLY-MANAGED` marker, the way the `python-data` Software already did. A sandbox is one person's throwaway machine, and agents reach for `pip` first. `/root/.local/bin` is on `PATH`, so `uv tool install` and `pip install --user` commands run. The `uv` catalog entry is retired, like `chrome` before it (ADR-0004's retirement rule).
- **Small, commonly needed tools go in the base image** (`file less procps python-is-python3 sqlite3 unzip wget xz-utils zip`). Large or specialized ones stay Software (Node.js, FFmpeg, ImageMagick, Python data science), so a plain shell does not carry hundreds of MB that most conversations never use.
- **The `workspace` prompt section lists the base tools**, says to run `apt-get update` before `apt-get install`, and says what the agent installs is lost when the machine is replaced. A few dozen tokens on every request cost less than the turns spent finding this out.
- **`command_not_found_handle`** (`docker/sandbox/sandbox-env.sh`) answers a missing command with the next step: the catalog entry that provides it, `uvx`/`pip` for Python tools, or `apt-get update` first. The agent's commands run as non-interactive `bash -c`, which reads only `BASH_ENV`, so the image sets it. The Shell tab's interactive `bash -l` sources it from `/etc/bash.bashrc`. Each catalog entry lists its `commands`, and a test checks the handler against them.

Cost, measured on Intel Linux, Docker 29: the extra apt packages add 11MB (132MB to 143MB for that layer), and uv with pip adds 60MB. The shell image has 831MB of Chrome next to it.

## Rejected

- **Ubuntu's `command-not-found` package**: it needs apt's package lists, which the image deletes to stay small, and it suggests only apt, never catalog Software or `uvx`.
- **Keeping apt's package lists in the image**: about 40MB, and they go stale after the build. The prompt and the handler say to run `apt-get update`.
- **Node.js in the base image**: 58MB, and fewer tasks need it than Python. It stays Software, and the handler points to it.

## Open

- The agent cannot add catalog Software itself; the handler tells it to ask the person. Letting `upgrade_workspace` take `software` would let the agent add it, at the cost of an image build on first use.
- How often each missing command comes up is not measured, so what goes in the base image is a guess. Counting exit-127 results in traces would turn it into data.

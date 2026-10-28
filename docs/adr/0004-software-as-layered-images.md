# Software is built into layered images on demand, not installed at start

A person can add Software (Node.js, uv, Python data science, ImageMagick, FFmpeg, Google Chrome) on top of a Level's image (issue #21). Each selection becomes an image `FROM` the Level's image with one `RUN` layer per entry in catalog order, tagged by a hash of the base image's id and that Dockerfile, built the first time it is needed. Installing at Sandbox start would cost every Seat the full install again (Node.js: 75s at start vs 5.7s from a built image); a build costs one to two installs, once per selection, and Docker's layer cache shares common prefixes.

## Decisions

- **Software** is the term. "Tools" already means the agent's tools and "packages" means apt packages.
- `WorkspaceDoc.software` only grows, like the Level. Adding software to a running conversation is an Upgrade at the same Level: a new Sandbox over the same files.
- A rebuilt base image changes the hash, so a stale image is never used. Builds are serialized, so two Seats asking for one image build it once. Images carry the `effect-pi.software` label for pruning.
- Python data science goes through uv, not apt: apt was slower (84s vs 46s) with older pandas and numpy, and Ubuntu refused `pip install` outside a venv.

## Consequences

The first conversation with a new selection waits for its build, minutes on a home connection. Building common selections ahead of time, and building in the background, are open.

## Measurements

One run each on an Intel Mac, Docker Desktop 29.4, over the shell image:

| Entry                           | Build | Layer |
| ------------------------------- | ----- | ----- |
| Node.js 24, with pnpm and yarn  | 17.3s | 58MB  |
| uv                              | 9.0s  | 22MB  |
| Python data science, through uv | 46.4s | 111MB |
| ImageMagick                     | 36.0s | 31MB  |
| FFmpeg                          | 92.5s | 166MB |

Pandoc with LibreOffice (122s, 212MB) and Blender were checked and left out.

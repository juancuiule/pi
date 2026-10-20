// Software: programs installed in a Workspace's Sandboxes on top of its Level's image (see GLOSSARY.md and
// docs/plans/software.md). The catalog and its rules, with no runtime imports: the HTTP API, which web/ bundles,
// reads them. Every entry installs on its own, so any selection builds.
import type { SandboxChoice, SandboxKind } from "./sandbox.ts";

/** In catalog order, which is also the order of the image's layers. */
export const SOFTWARE_IDS = [
  "node",
  "uv",
  "python-data",
  "imagemagick",
  "ffmpeg",
  "chrome",
  "agent-browser",
] as const;
export type SoftwareId = (typeof SOFTWARE_IDS)[number];

interface SoftwareSpec {
  readonly label: string;
  /** One line for the console's checklist. */
  readonly description: string;
  /** The lowest Level that offers it. */
  readonly level: SandboxKind;
  /** Shell commands for one image layer. */
  readonly install: string;
  /** What the agent is told is installed. */
  readonly prompt: string;
  /** The host architectures it installs on; every one when absent. */
  readonly arch?: readonly ("x64" | "arm64")[];
}

const UV =
  "ARCH=$(uname -m) && curl -fsSL https://github.com/astral-sh/uv/releases/download/0.9.5/uv-$ARCH-unknown-linux-gnu.tar.gz | tar -xz -C /usr/local/bin --strip-components=1";

const apt = (packages: string) =>
  `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*`;

// agent-browser's release binary, checked against the digest GitHub publishes for it, under a wrapper on the PATH
// that sets this platform's defaults for every caller, the browser tools and `bash` alike:
// - one session for every caller, since two browsers cannot share a profile;
// - the profile lives in the Workspace, so logins survive a Pause; a Sandbox that stopped with the browser open
//   leaves Chrome's Singleton lock files behind, naming a host that is gone, and Chrome refuses such a profile, so
//   they are removed while no Chrome runs;
// - page output is wrapped in boundary markers and capped;
// - Chrome runs without its own sandbox (the container is one, and Chrome refuses root otherwise) and without
//   /dev/shm, which Docker keeps small;
// - on a desktop the browser opens on the display, so the person watches it in noVNC; on a shell it is headless.
const AGENT_BROWSER_VERSION = "0.39.1";
const AGENT_BROWSER_SHA256 =
  "6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc";
// What `agent-browser install --with-deps` would install for Chrome on Ubuntu 24.04; it runs them through `sudo`,
// which the image does not have.
const CHROME_PACKAGES = [
  "libxcb-shm0",
  "libx11-xcb1",
  "libx11-6",
  "libxcb1",
  "libxext6",
  "libxrandr2",
  "libxcomposite1",
  "libxcursor1",
  "libxdamage1",
  "libxfixes3",
  "libxi6",
  "libgtk-3-0t64",
  "libpangocairo-1.0-0",
  "libpango-1.0-0",
  "libatk1.0-0t64",
  "libcairo-gobject2",
  "libcairo2",
  "libgdk-pixbuf-2.0-0",
  "libxrender1",
  "libasound2t64",
  "libfreetype6",
  "libfontconfig1",
  "libdbus-1-3",
  "libnss3",
  "libnss3-tools",
  "libnspr4",
  "libatk-bridge2.0-0t64",
  "libdrm2",
  "libxkbcommon0",
  "libatspi2.0-0t64",
  "libcups2t64",
  "libxshmfence1",
  "libgbm1",
  "fonts-noto-color-emoji",
  "fonts-noto-cjk",
  "fonts-freefont-ttf",
];
// The wrapper's lines are shell, whose `${...}` must reach the file as written.
/* oxlint-disable no-template-curly-in-string */
const AGENT_BROWSER_WRAPPER = [
  "#!/bin/sh",
  'P="${AGENT_BROWSER_PROFILE:-/workspace/.browser}"',
  'export AGENT_BROWSER_PROFILE="$P"',
  'export AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-workspace}"',
  'export AGENT_BROWSER_CONTENT_BOUNDARIES="${AGENT_BROWSER_CONTENT_BOUNDARIES:-1}"',
  'export AGENT_BROWSER_MAX_OUTPUT="${AGENT_BROWSER_MAX_OUTPUT:-40000}"',
  'export AGENT_BROWSER_ARGS="${AGENT_BROWSER_ARGS:---no-sandbox,--disable-dev-shm-usage}"',
  'if [ -z "${AGENT_BROWSER_HEADED:-}" ] && [ -n "${DISPLAY:-}" ] && xdpyinfo >/dev/null 2>&1; then export AGENT_BROWSER_HEADED=1; fi',
  'cat /proc/[0-9]*/comm 2>/dev/null | grep -qx chrome || rm -f "$P"/Singleton*',
  'exec /opt/agent-browser/agent-browser "$@"',
];
/* oxlint-enable no-template-curly-in-string */

export const SOFTWARE: Record<SoftwareId, SoftwareSpec> = {
  node: {
    label: "Node.js 24",
    description: "Node.js with npm, pnpm and yarn, to run JavaScript.",
    level: "shell",
    install:
      'ARCH=$(dpkg --print-architecture | sed "s/amd64/x64/") && curl -fsSL https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-$ARCH.tar.gz | tar -xz -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md && corepack enable pnpm yarn',
    prompt: "Node.js 24 (`node`, `npm`, `npx`, `pnpm`, `yarn`)",
  },
  uv: {
    label: "uv (Python packages)",
    description: "Astral's uv, for Python virtual environments and packages.",
    level: "shell",
    install: UV,
    prompt:
      "uv, which manages Python environments and packages (`uv venv`, `uv pip install`, `uv run`). Use it instead of pip.",
  },
  "python-data": {
    label: "Python data science",
    description:
      "numpy, pandas, matplotlib, scipy and openpyxl, with pip and uv.",
    level: "shell",
    install: `${UV} && uv pip install --system --break-system-packages --no-cache pip numpy pandas matplotlib scipy openpyxl && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED && printf "[global]\\nroot-user-action = ignore\\n" > /etc/pip.conf`,
    prompt:
      "numpy, pandas, matplotlib, scipy and openpyxl for the system python3, plus `pip` and `uv`. `pip install` works system-wide. Use matplotlib's Agg backend to save charts as files.",
  },
  imagemagick: {
    label: "ImageMagick",
    description: "Convert, resize and edit images from the shell.",
    level: "shell",
    install: apt("imagemagick"),
    prompt: "ImageMagick (`convert`, `identify`, `mogrify`)",
  },
  ffmpeg: {
    label: "FFmpeg",
    description: "Convert, cut and inspect audio and video.",
    level: "shell",
    install: apt("ffmpeg"),
    prompt: "FFmpeg (`ffmpeg`, `ffprobe`)",
  },
  chrome: {
    label: "Google Chrome",
    description: "The Chrome browser, on the desktop.",
    level: "desktop",
    install:
      "curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/chrome.deb && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb",
    prompt: "Google Chrome (`google-chrome`)",
    arch: ["x64"],
  },
  "agent-browser": {
    label: "Browser for the agent",
    description:
      "agent-browser and Chrome, so the agent can open and use websites.",
    level: "shell",
    install: [
      "mkdir -p /opt/agent-browser",
      `curl -fsSL -o /opt/agent-browser/agent-browser https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-linux-x64`,
      `echo "${AGENT_BROWSER_SHA256}  /opt/agent-browser/agent-browser" | sha256sum -c -`,
      "chmod +x /opt/agent-browser/agent-browser",
      apt(CHROME_PACKAGES.join(" ")),
      "/opt/agent-browser/agent-browser install",
      `printf '%s\\n' ${AGENT_BROWSER_WRAPPER.map((line) => `'${line}'`).join(" ")} > /usr/local/bin/agent-browser`,
      "chmod +x /usr/local/bin/agent-browser",
    ].join(" && "),
    prompt:
      "agent-browser with Chrome, behind the `browser_*` tools; `agent-browser skills get core` documents commands the tools do not cover, which run through `bash`",
    // Chrome for Testing, which agent-browser installs, has no Linux arm64 build.
    arch: ["x64"],
  },
};

/** Levels in the order an Upgrade goes. */
export const LEVEL_RANK: Record<SandboxChoice, number> = {
  none: 0,
  shell: 1,
  desktop: 2,
};

const runsOn = (id: SoftwareId, arch: string) =>
  SOFTWARE[id].arch?.some((each) => each === arch) ?? true;

/** What a Workspace at `level` can have on this host, in catalog order. */
export const offered = (
  level: SandboxChoice,
  arch: string = process.arch
): SoftwareId[] =>
  SOFTWARE_IDS.filter(
    (id) =>
      LEVEL_RANK[SOFTWARE[id].level] <= LEVEL_RANK[level] && runsOn(id, arch)
  );

/** In catalog order, each once. */
export const normalize = (ids: readonly SoftwareId[]): SoftwareId[] =>
  SOFTWARE_IDS.filter((id) => ids.includes(id));

/** Why a Workspace at `level` cannot have `ids` on this host, or `undefined` when it can. */
export const checkSoftware = (
  level: SandboxChoice,
  ids: readonly SoftwareId[],
  arch: string = process.arch
): string | undefined => {
  if (ids.length === 0) {
    return undefined;
  }
  if (level === "none") {
    return "Software needs a shell or desktop";
  }
  for (const id of normalize(ids)) {
    const spec = SOFTWARE[id];
    if (LEVEL_RANK[spec.level] > LEVEL_RANK[level]) {
      return `${spec.label} needs the ${spec.level} Level`;
    }
    if (!runsOn(id, arch)) {
      return `${spec.label} is not available on ${arch} hosts`;
    }
  }
  return undefined;
};

/** The image for `ids` over `base`: one layer per entry, in catalog order, so selections share a prefix's layers. */
export const dockerfile = (base: string, ids: readonly SoftwareId[]): string =>
  [
    `FROM ${base}`,
    ...normalize(ids).map((id) => `RUN ${SOFTWARE[id].install}`),
    "",
  ].join("\n");

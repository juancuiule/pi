// Software: programs installed in a Workspace's Sandboxes on top of its Level's image (see GLOSSARY.md and
// docs/adr/0004-software-as-layered-images.md). The catalog and its rules, with no runtime imports: the HTTP API, which web/ bundles,
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
      // Google ships Chrome for amd64 and, since July 2026, arm64 Linux; dpkg names them as Google's packages do.
      'curl -fsSL -o /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_$(dpkg --print-architecture).deb" && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/chrome.deb && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb',
    prompt: "Google Chrome (`google-chrome`)",
    arch: ["x64", "arm64"],
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

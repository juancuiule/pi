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
  /** The commands it provides, which docker/sandbox/sandbox-env.sh names when one is missing. */
  readonly commands: readonly string[];
  /** The host architectures it installs on; every one when absent. */
  readonly arch?: readonly ("x64" | "arm64")[];
  /**
   * Why it is no longer offered: a base image has it now. The id stays so Workspaces that recorded it still load;
   * `normalize` drops it, so it builds no layer and is never checked or listed again.
   */
  readonly retired?: string;
}

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
    commands: ["node", "npm", "npx", "pnpm", "yarn", "corepack"],
  },
  uv: {
    label: "uv (Python packages)",
    description: "Astral's uv, for Python virtual environments and packages.",
    level: "shell",
    install: "true",
    prompt: "uv",
    commands: [],
    retired:
      "Every shell and desktop image has uv and a pip that installs system-wide",
  },
  "python-data": {
    label: "Python data science",
    description: "numpy, pandas, matplotlib, scipy and openpyxl.",
    level: "shell",
    // The base image has uv and pip (docker/sandbox/shell.Dockerfile).
    install:
      "uv pip install --system --break-system-packages --no-cache numpy pandas matplotlib scipy openpyxl",
    prompt:
      "numpy, pandas, matplotlib, scipy and openpyxl for the system python3. Use matplotlib's Agg backend to save charts as files.",
    commands: [],
  },
  imagemagick: {
    label: "ImageMagick",
    description: "Convert, resize and edit images from the shell.",
    level: "shell",
    install: apt("imagemagick"),
    prompt: "ImageMagick (`convert`, `identify`, `mogrify`)",
    commands: ["convert", "identify", "mogrify", "magick"],
  },
  ffmpeg: {
    label: "FFmpeg",
    description: "Convert, cut and inspect audio and video.",
    level: "shell",
    install: apt("ffmpeg"),
    prompt: "FFmpeg (`ffmpeg`, `ffprobe`)",
    commands: ["ffmpeg", "ffprobe"],
  },
  chrome: {
    label: "Google Chrome",
    description: "The Chrome browser, on the desktop.",
    level: "desktop",
    install: "true",
    prompt: "Google Chrome (`google-chrome`)",
    commands: [],
    arch: ["x64", "arm64"],
    retired:
      "Every shell and desktop image has Google Chrome, for agent-browser",
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
      SOFTWARE[id].retired === undefined &&
      LEVEL_RANK[SOFTWARE[id].level] <= LEVEL_RANK[level] &&
      runsOn(id, arch)
  );

/** In catalog order, each once, without retired entries. */
export const normalize = (ids: readonly SoftwareId[]): SoftwareId[] =>
  SOFTWARE_IDS.filter(
    (id) => SOFTWARE[id].retired === undefined && ids.includes(id)
  );

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

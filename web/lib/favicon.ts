// The console's favicon, badged with the state of all conversations (`consoleSummaryOf`): the app's own icon
// while idle, with a corner mark otherwise, its shape repeating the sidebar dot's (error a square, the rest
// circles) so color is never the only cue. Drawn once per state change on a canvas; nothing animates.
import type { ConsoleStatus } from "./conversation-status";

export interface Badge {
  readonly shape: "circle" | "square";
  /** Fixed colors: a canvas cannot read the theme's oklch tokens everywhere, and the tab strip has its own theme. */
  readonly color: string;
}

export const BADGE: Record<ConsoleStatus, Badge | undefined> = {
  idle: undefined,
  running: { shape: "circle", color: "#16a34a" },
  waiting: { shape: "circle", color: "#f59e0b" },
  error: { shape: "square", color: "#dc2626" },
};

const SIZE = 64;

const draw = (base: HTMLImageElement | undefined, badge: Badge): string => {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (context === null) {
    return "";
  }
  if (base !== undefined) {
    context.drawImage(base, 0, 0, SIZE, SIZE);
  }
  // A white rim keeps the mark apart from the icon on any tab strip.
  const center = SIZE * 0.72;
  const radius = SIZE * 0.26;
  context.fillStyle = badge.color;
  context.strokeStyle = "#ffffff";
  context.lineWidth = SIZE * 0.07;
  context.beginPath();
  if (badge.shape === "circle") {
    context.arc(center, center, radius, 0, Math.PI * 2);
  } else {
    context.rect(center - radius, center - radius, radius * 2, radius * 2);
  }
  context.stroke();
  context.fill();
  return canvas.toDataURL("image/png");
};

let baseImage: Promise<HTMLImageElement | undefined> | undefined;

// Without the icon the badge still says the state.
const decoded = async (href: string): Promise<HTMLImageElement | undefined> => {
  const image = new Image();
  image.src = href;
  const ok = await image.decode().then(
    () => true,
    () => false
  );
  return ok ? image : undefined;
};

const loadBase = (href: string) => {
  baseImage ??= decoded(href);
  return baseImage;
};

const iconLinks = () =>
  [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map(
    (link) => {
      // The href and type Next rendered, kept on the element to put back while idle.
      link.dataset.originalHref ??= link.href;
      link.dataset.originalType ??= link.type;
      return link;
    }
  );

let applied = 0;

/** Badge every icon link (Next renders one for app/favicon.ico) for `status`, or put the original back for `idle`. */
export const applyFavicon = async (status: ConsoleStatus): Promise<void> => {
  applied += 1;
  const turn = applied;
  const links = iconLinks();
  const badge = BADGE[status];
  if (badge === undefined) {
    for (const link of links) {
      link.href = link.dataset.originalHref ?? link.href;
      link.type = link.dataset.originalType ?? "";
    }
    return;
  }
  const original = links[0]?.dataset.originalHref;
  const base = original === undefined ? undefined : await loadBase(original);
  // A newer state landed while the icon loaded.
  if (turn !== applied) {
    return;
  }
  const url = draw(base, badge);
  if (url === "") {
    return;
  }
  for (const link of links) {
    link.href = url;
    link.type = "image/png";
  }
};

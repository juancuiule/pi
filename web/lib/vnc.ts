/** The sandbox's noVNC URL, view-only unless the user has taken control. */
export const vncViewUrl = (vncUrl: string, control: boolean): string => {
  const url = new URL(vncUrl);
  url.searchParams.set("view_only", String(!control));
  return url.toString();
};

/**
 * The document the desktop panel frames: a same-origin page of this console, which carries its own `frame-src`
 * for the sandbox's loopback noVNC port, so the console's `frame-src 'self'` stays tight for artifact pages.
 */
export const desktopFrameUrl = (
  conversation: number,
  control: boolean
): string =>
  `/desktop-frame?conversation=${conversation}&control=${control ? 1 : 0}`;

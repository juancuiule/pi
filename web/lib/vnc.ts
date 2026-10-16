/** The sandbox's noVNC URL, view-only unless the user has taken control. */
export const vncViewUrl = (vncUrl: string, control: boolean): string => {
  const url = new URL(vncUrl);
  url.searchParams.set("view_only", String(!control));
  return url.toString();
};

/** The document the desktop panel frames. */
export const desktopFrameUrl = (vncUrl: string, control: boolean): string =>
  vncViewUrl(vncUrl, control);

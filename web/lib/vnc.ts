/** The sandbox's noVNC URL, view-only unless the user has taken control. */
export const vncViewUrl = (vncUrl: string, control: boolean): string => {
  const url = new URL(vncUrl);
  url.searchParams.set("view_only", String(!control));
  return url.toString();
};

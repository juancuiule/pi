// A `web_search` result's `details.sources`, read defensively like every details field: the console renders them as
// links. The shape comes from `detailsOf` in src/web-search/format.ts.

export interface SearchSource {
  readonly title: string;
  readonly url: string;
  readonly publishedDate?: string;
}

const isSource = (value: unknown): value is SearchSource => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { title, url, publishedDate } = value as Record<string, unknown>;
  return (
    typeof title === "string" &&
    typeof url === "string" &&
    /^https?:\/\//u.test(url) &&
    (publishedDate === undefined || typeof publishedDate === "string")
  );
};

/** `details.sources` of a `web_search` result: the pages it drew from; `[]` when absent or malformed. */
export const sourcesOf = (details: unknown): readonly SearchSource[] => {
  if (typeof details !== "object" || details === null) {
    return [];
  }
  const { sources } = details as Record<string, unknown>;
  return Array.isArray(sources) ? sources.filter(isSource) : [];
};

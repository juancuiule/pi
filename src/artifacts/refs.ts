import { Effect } from "effect";
// The external references a page makes, found statically so artifact_create/artifact_update can refuse a page the
// sandboxed render would break: an <img> to an untrusted host fails the page's img-src CSP with a console error the
// model never sees. Refusing at write time gives the model an error it can act on — and tells the person which
// domain to trust (domains.ts) if the page legitimately wants it.
//
// What is checked mirrors the render CSP: scripts only same-origin (artifact-libs), images same-origin/data:/blob:
// or a trusted domain, everything else nothing. Inline script bodies are not scanned — connect-src 'none' already
// stops fetch/XHR at runtime, and URLs in strings cannot be told from images created later.
import { Parser } from "htmlparser2";

import { ArtifactRefused } from "../errors.ts";
import { isTrusted } from "./domains.ts";

/** `image` URLs may come from a trusted domain; `script` only same-origin; `blocked` never loads. */
type Kind = "image" | "script" | "blocked";

interface Ref {
  readonly kind: Kind;
  /** What the element would load; a label like "@import" for a kind without a URL. */
  readonly url: string;
  /** The label a refusal reports for a `blocked` ref, e.g. "external scripts". */
  readonly label: string | undefined;
}

/** Elements that never have an end tag; pushing them would misreport a `source`'s parent. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Every URL candidate of a srcset: `url descriptor, url descriptor`. */
const srcset = (value: string): string[] =>
  value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/u)[0] ?? "")
    .filter((url) => url !== "");

/**
 * `url(...)` references in inline CSS; `@import` is reported separately by the caller.
 *
 * @yields {string} each `url(...)`'s address, in order
 */
const cssUrls = function* (css: string) {
  for (const match of css.matchAll(
    /url\(\s*(?<quote>['"]?)(?<url>.*?)\k<quote>\s*\)/gu
  )) {
    yield match.groups?.url ?? "";
  }
};

/** A page's references to anything it could load, in document order. */
export const externalRefs = (html: string): readonly Ref[] => {
  const refs: Ref[] = [];
  // The open-element stack, only to tell a <source>'s parent (picture is image; video/audio is blocked media).
  const stack: string[] = [];
  let inStyle = false;
  let styleText = "";

  const push = (kind: Kind, url: string | undefined, label?: string) => {
    if (url !== undefined && url.trim() !== "") {
      refs.push({ kind, url: url.trim(), label });
    }
  };

  const css = (text: string) => {
    for (const url of cssUrls(text)) {
      push("image", url);
    }
    if (/@import/iu.test(text)) {
      push("blocked", "@import", "CSS imports");
    }
  };

  const MEDIA = "audio and video";

  /** The refs one element's attributes make; `parent` is the enclosing tag (for a `source` under `picture`). */
  const tags: Record<
    string,
    (a: Record<string, string>, parent: string | undefined) => void
  > = {
    script: (a) => {
      push("script", a.src, "external scripts");
      push("script", a.href, "external scripts");
      push("script", a["xlink:href"], "external scripts");
    },
    link: (a) => {
      push(
        (a.rel ?? "").toLowerCase().includes("icon") ? "image" : "blocked",
        a.href,
        "external stylesheets or other link resources"
      );
    },
    img: (a) => {
      push("image", a.src);
      for (const url of srcset(a.srcset ?? "")) {
        push("image", url);
      }
    },
    input: (a) => {
      if ((a.type ?? "").toLowerCase() === "image") {
        push("image", a.src);
      }
    },
    image: (a) => {
      push("image", a.href);
      push("image", a["xlink:href"]);
    },
    use: (a) => {
      push("image", a.href);
      push("image", a["xlink:href"]);
    },
    source: (a, parent) => {
      if (parent === "picture") {
        push("image", a.src);
        for (const url of srcset(a.srcset ?? "")) {
          push("image", url);
        }
      } else {
        push("blocked", a.src, MEDIA);
        push("blocked", a.srcset, MEDIA);
      }
    },
    video: (a) => {
      push("blocked", a.src, MEDIA);
      push("image", a.poster);
    },
    audio: (a) => push("blocked", a.src, MEDIA),
    track: (a) => push("blocked", a.src, MEDIA),
    iframe: (a) => push("blocked", a.src, "frames"),
    frame: (a) => push("blocked", a.src, "frames"),
    embed: (a) => push("blocked", a.src, "embedded objects"),
    object: (a) => push("blocked", a.data, "embedded objects"),
    form: (a) => push("blocked", a.action, "form submissions"),
    // A same-origin base only re-roots relative URLs; a remote one would smuggle them out.
    base: (a) => push("script", a.href, "a base URL"),
    body: (a) => push("image", a.background),
    table: (a) => push("image", a.background),
    td: (a) => push("image", a.background),
    th: (a) => push("image", a.background),
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (!VOID.has(name)) {
          stack.push(name);
        }
        if (name === "style") {
          inStyle = true;
        }
        tags[name]?.(attributes, stack.at(-1));
        if (attributes.formaction !== undefined) {
          push("blocked", attributes.formaction, "form submissions");
        }
        if (attributes.style !== undefined) {
          css(attributes.style);
        }
      },
      ontext(text) {
        if (inStyle) {
          styleText += text;
        }
      },
      onclosetag(name) {
        if (name === "style" && inStyle) {
          inStyle = false;
          css(styleText);
          styleText = "";
        }
        const at = stack.lastIndexOf(name);
        if (at !== -1) {
          stack.length = at;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(html);
  parser.end();
  if (inStyle) {
    css(styleText);
  }
  return refs;
};

type Classified =
  | { readonly type: "self" | "inline" }
  | { readonly type: "remote"; readonly host: string }
  | { readonly type: "other" };

/** A reference's URL by where it points: this origin, a data:/blob: body, a remote host, or another scheme. */
const classify = (url: string): Classified => {
  if (url === "" || url.startsWith("#")) {
    return { type: "self" };
  }
  if (/^(?:data:|blob:)/iu.test(url)) {
    return { type: "inline" };
  }
  if (/^https?:\/\//iu.test(url) || url.startsWith("//")) {
    try {
      // `host` keeps a non-default port, matching a `host:port` entry.
      return {
        type: "remote",
        host: new URL(url.startsWith("//") ? `https:${url}` : url).host,
      };
    } catch {
      return { type: "other" };
    }
  }
  return /^[a-z][a-z0-9+.-]*:/iu.test(url)
    ? { type: "other" }
    : { type: "self" };
};

/**
 * The first problem with a page's references: never-loadable elements (remote scripts and styles, frames, media,
 * forms, CSS imports, odd schemes), and image URLs on hosts outside `trusted`. `undefined` when the page loads
 * only what its CSP allows.
 */
export const checkRefs = (
  html: string,
  trusted: readonly string[]
): ArtifactRefused | undefined => {
  const blocked = new Set<string>();
  const untrusted = new Set<string>();
  for (const ref of externalRefs(html)) {
    const url = classify(ref.url);
    // These elements load nothing even same-origin: frames and media fall to default-src 'none', link resources to
    // style-src 'unsafe-inline', form targets to form-action 'none'.
    if (ref.kind === "blocked") {
      blocked.add(ref.label ?? "external resources");
      continue;
    }
    if (
      url.type === "self" ||
      (ref.kind === "image" && url.type === "inline")
    ) {
      continue;
    }
    if (ref.kind === "image" && url.type === "remote") {
      if (isTrusted(url.host, trusted)) {
        continue;
      }
      untrusted.add(url.host);
      continue;
    }
    blocked.add(
      url.type === "other" && ref.kind === "image"
        ? "non-web image URLs"
        : (ref.label ?? "external scripts")
    );
  }
  if (blocked.size === 0 && untrusted.size === 0) {
    return undefined;
  }
  const problems: string[] = [];
  if (blocked.size > 0) {
    problems.push(
      `A page cannot load ${[...blocked].join(", ")}: it fetches nothing but images.`
    );
  }
  if (untrusted.size > 0) {
    const hosts = [...untrusted].join(", ");
    problems.push(
      `Images may come only from this server, data:/blob: URLs${
        trusted.length === 0
          ? ""
          : ` and trusted domains (${trusted.join(", ")})`
      }: ${hosts} ${
        untrusted.size === 1 ? "is" : "are"
      } not trusted — the person can add a domain in Settings → Trusted domains, or the image can go in your message as markdown.`
    );
  }
  return new ArtifactRefused({ reason: problems.join(" ") });
};

/** `checkRefs` as an Effect: fails when the page references something it cannot load. */
export const checkPage = (
  html: string,
  trusted: readonly string[]
): Effect.Effect<void, ArtifactRefused> => {
  const problem = checkRefs(html, trusted);
  return problem === undefined ? Effect.void : Effect.fail(problem);
};

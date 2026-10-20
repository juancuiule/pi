"use client";

import { CodeXml, ImageIcon, LoaderCircle, Waypoints } from "lucide-react";
import { isValidElement, useEffect, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { cn } from "@/lib/utils";

/** Unique prefixes for pele's accessibility ids, serial across concurrent diagrams. */
let serial = 0;

/** Loads pele (only when a diagram is first shown) and renders `code` to SVG. */
const draw = async (
  code: string
): Promise<{ readonly svg: string } | { readonly error: string }> => {
  const { renderAsync } = await import("pele/lazy");
  try {
    const rendered = await renderAsync(code, {
      idPrefix: `effect-pi-pele-${(serial += 1)}`,
    });
    return { svg: rendered.svg };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/** A ```mermaid fence, drawn as a diagram, with the source behind a toggle. Pele loads on the first one. */
const MermaidDiagram = ({
  code,
  source,
}: {
  code: string;
  /** The fence's highlighted lines, shown as the source view. */
  source: ReactNode[];
}) => {
  const [showSource, setShowSource] = useState(false);
  const [result, setResult] = useState<
    { readonly svg: string } | { readonly error: string } | undefined
  >();

  useEffect(() => {
    let cancelled = false;
    // The source changes as it streams in; only render once it settles briefly.
    const timer = setTimeout(() => {
      void (async () => {
        const drawn = await draw(code);
        if (!cancelled) {
          setResult(drawn);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  const failed = result !== undefined && "error" in result;
  let body: ReactNode;
  if (showSource || failed) {
    body = (
      <>
        <CodeBlockContent>{source}</CodeBlockContent>
        {failed ? (
          <p role="alert" className="text-destructive px-3 pb-3 text-xs">
            This diagram cannot be rendered: {result.error}
          </p>
        ) : null}
      </>
    );
  } else if (result === undefined) {
    body = (
      <p className="text-muted-foreground flex items-center gap-2 px-3 pb-3 text-xs">
        <LoaderCircle
          aria-hidden
          className="size-3.5 motion-safe:animate-spin"
        />
        Drawing the diagram…
      </p>
    );
  } else {
    body = (
      <div
        className="scroll-fade-x overflow-x-auto px-3 pb-3 [&_svg]:max-w-full"
        // oxlint-disable-next-line react/no-danger -- pele's own SVG: no scripts, handlers or HTML labels; links limited to safe schemes
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    );
  }

  return (
    <CodeBlock className="my-2">
      <CodeBlockActions>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={showSource ? "Show diagram" : "Show source"}
          aria-pressed={showSource}
          title={showSource ? "Show diagram" : "Show source"}
          onClick={() => setShowSource((shown) => !shown)}
        >
          {showSource ? <Waypoints /> : <CodeXml />}
        </Button>
        <CodeBlockCopyButton value={code} />
      </CodeBlockActions>
      {body}
    </CodeBlock>
  );
};

/** A fenced code block: `pre` receives its inner `code` element, carrying `language-*` and the text. */
const CodeFence = ({ children }: { children?: ReactNode }) => {
  const inner = isValidElement<{
    className?: string;
    children?: ReactNode;
  }>(children)
    ? children
    : null;
  const className =
    typeof inner?.props.className === "string" ? inner.props.className : "";
  const language =
    className
      .split(" ")
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length) ?? "";
  const raw = inner?.props.children ?? children;
  const text = (Array.isArray(raw) ? raw.join("") : String(raw ?? "")).replace(
    /\n$/u,
    ""
  );
  const lines = useHighlightedCode(text, language);
  if (language === "mermaid") {
    return <MermaidDiagram code={text} source={lines} />;
  }
  return (
    <CodeBlock className="my-2">
      <CodeBlockActions>
        <CodeBlockCopyButton value={text} />
      </CodeBlockActions>
      <CodeBlockContent>
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no id; the list only grows
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

/**
 * An image in the agent's own reply: shown inline and wrapped in a link to its
 * URL. A src react-markdown strips (`javascript:`, `data:`) shows only the
 * label; one that fails to load shows the label plus the address, so a broken
 * URL stays visible instead of an empty frame.
 */
const TrustedImage = ({ src, alt }: { src?: string | Blob; alt?: string }) => {
  const [failed, setFailed] = useState(false);
  const label = `[image${alt === undefined || alt === "" ? "" : `: ${alt}`}]`;
  if (typeof src !== "string" || src === "") {
    return <span className="text-muted-foreground">{label}</span>;
  }
  if (failed) {
    return (
      <span className="text-muted-foreground">
        {label}{" "}
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          {src}
        </a>
      </span>
    );
  }
  return (
    <a href={src} target="_blank" rel="noreferrer">
      {/* oxlint-disable-next-line next/no-img-element -- remote URL chosen at runtime; next/image cannot size it */}
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="my-2 max-w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      />
    </a>
  );
};

// Element overrides only — no typography plugin, no raw HTML (react-markdown's default).
export const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="my-2 wrap-anywhere first:mt-0 last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="font-heading mt-4 mb-2 text-lg font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-heading mt-4 mb-2 text-base font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-prose mt-3 mb-1.5 font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-prose mt-3 mb-1.5 font-semibold first:mt-0">
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="marker:text-muted-foreground my-2 list-disc space-y-1 pl-6">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="marker:text-muted-foreground my-2 list-decimal space-y-1 pl-6">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2"
    >
      {children}
    </a>
  ),
  img: TrustedImage,
  code: ({ className, children }) => {
    // A language class means a fenced block, rendered by `pre` below.
    if (className !== undefined) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="bg-muted text-ui rounded px-1 py-0.5 font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeFence>{children}</CodeFence>,
  hr: () => <hr className="border-border my-4" />,
  table: ({ children }) => (
    <div className="scroll-fade-x my-2 overflow-x-auto">
      <table className="border-border w-full border-collapse text-sm tabular-nums">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-border border-b px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-border border-b px-2 py-1 align-top">{children}</td>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
};

/**
 * A link in a file the reader did not write: show where it goes before opening
 * it. A button, not an anchor, so no click opens the destination directly.
 */
const UntrustedLink = ({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) => {
  const [asking, setAsking] = useState(false);
  if (href === undefined || href === "") {
    return children;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="inline cursor-pointer underline underline-offset-2"
      >
        {children}
      </button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open this link?</AlertDialogTitle>
            <AlertDialogDescription>
              This link came from an uploaded file; its author chose the
              destination. It opens in a new tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="bg-muted rounded-md px-3 py-2 font-mono text-xs break-all select-all">
            {href}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                window.open(href, "_blank", "noopener,noreferrer");
                setAsking(false);
              }}
            >
              Open link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/**
 * An image in a file the reader did not write: loading it fetches an address
 * the file's author chose, so it loads only when the person asks for it.
 */
const UntrustedImage = ({
  src,
  alt,
}: {
  src?: string | Blob;
  alt?: string;
}) => {
  const [shown, setShown] = useState(false);
  const label = `[image${alt === undefined || alt === "" ? "" : `: ${alt}`}]`;
  if (typeof src !== "string" || src === "") {
    return <span className="text-muted-foreground">{label}</span>;
  }
  if (shown) {
    return (
      // oxlint-disable-next-line next/no-img-element -- fetched only on demand; the file does not load it on its own
      <img
        src={src}
        alt={alt ?? ""}
        referrerPolicy="no-referrer"
        className="my-2 max-w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
      />
    );
  }
  return (
    <span className="text-muted-foreground inline-flex items-baseline gap-1.5">
      {label}
      <button
        type="button"
        onClick={() => setShown(true)}
        title={src}
        className="bg-background text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-md border px-1.5 align-baseline text-xs outline-none focus-visible:ring-2"
      >
        <ImageIcon aria-hidden className="size-3" />
        Show image
      </button>
    </span>
  );
};

/** For a document whose author is not the reader: raw HTML is parsed then sanitized (scripts, media, handlers die there), links ask before opening, images load only when asked. */
const untrustedComponents: Components = {
  ...markdownComponents,
  a: UntrustedLink,
  img: UntrustedImage,
};

export const Markdown = ({
  children,
  className,
  untrusted = false,
  components,
}: {
  children: string;
  className?: string;
  untrusted?: boolean;
  components?: Components;
}) => (
  <div className={cn("text-prose", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // Without rehype-raw raw HTML shows as text; sanitize keeps <img>/<a> as elements for the overrides while killing scripts, media and handlers.
      rehypePlugins={untrusted ? [rehypeRaw, rehypeSanitize] : []}
      components={{
        ...(untrusted ? untrustedComponents : markdownComponents),
        ...components,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

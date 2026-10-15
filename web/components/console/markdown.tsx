"use client";

import { ImageIcon } from "lucide-react";
import { isValidElement, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
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
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { cn } from "@/lib/utils";

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

// Element overrides only — no typography plugin, no raw HTML (react-markdown's default).
const components: Components = {
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
    <div className="my-2 overflow-x-auto">
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

/** For a document whose author is not the reader: links ask before opening, images load only when asked. */
const untrustedComponents: Components = {
  ...components,
  a: UntrustedLink,
  img: UntrustedImage,
};

export const Markdown = ({
  children,
  className,
  untrusted = false,
}: {
  children: string;
  className?: string;
  untrusted?: boolean;
}) => (
  <div className={cn("text-prose", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={untrusted ? untrustedComponents : components}
    >
      {children}
    </ReactMarkdown>
  </div>
);

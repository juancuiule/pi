"use client";

import { isValidElement } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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

export const Markdown = ({
  children,
  className,
}: {
  children: string;
  className?: string;
}) => (
  <div className={cn("text-prose", className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  </div>
);

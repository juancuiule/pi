import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

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
  pre: ({ children }) => (
    <pre className="bg-muted text-code my-2 overflow-x-auto rounded-lg p-3 font-mono leading-relaxed">
      {children}
    </pre>
  ),
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

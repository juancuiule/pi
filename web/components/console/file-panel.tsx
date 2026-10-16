"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { runApi } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { fileLanguage, isMarkdown } from "@/lib/workspace-files";
import type { OpenFile } from "@/lib/workspace-files";

import { Markdown } from "./markdown";

const Loading = () => (
  <p className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
    <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
    Loading…
  </p>
);

/** A file's text as highlighted source, like the tool calls' output; the file is never executed. */
const FileSource = ({ text, language }: { text: string; language: string }) => {
  const lines = useHighlightedCode(text, language);
  return (
    <CodeBlock size="sm" className="h-full">
      <CodeBlockActions>
        <CodeBlockCopyButton value={text} />
      </CodeBlockActions>
      <CodeBlockContent wrap lineNumbers className="min-h-0 flex-1">
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no id; a file's lines are stable
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

const TabSwitch = ({
  tab,
  onTab,
}: {
  tab: "preview" | "code";
  onTab: (tab: "preview" | "code") => void;
}) => (
  <div role="tablist" className="flex shrink-0 gap-1">
    {(
      [
        ["preview", "Preview"],
        ["code", "Code"],
      ] as const
    ).map(([value, label]) => (
      <button
        key={value}
        type="button"
        role="tab"
        aria-selected={tab === value}
        onClick={() => onTab(value)}
        className={buttonVariants({
          variant: tab === value ? "secondary" : "ghost",
          size: "sm",
        })}
      >
        {label}
      </button>
    ))}
  </div>
);

/**
 * A workspace file open beside the chat, in the pane artifacts use: rendered Markdown or highlighted source,
 * never executed (workspace HTML stays text). The view is refetched while open so the agent's writes and edits
 * land as they commit. A paused conversation has no Sandbox to read through — the pane says so and the next
 * refetch picks the file up once it resumes.
 */
export const FilePanel = ({
  file,
  conversation,
  onClose,
}: {
  file: OpenFile;
  conversation: number;
  onClose: () => void;
}) => {
  const { data, error } = useQuery({
    queryKey: ["workspace-file", conversation, file.path],
    queryFn: () =>
      runApi((c) =>
        c.files.content({
          params: { id: conversation },
          query: { path: file.path },
        })
      ),
    refetchInterval: 2000,
  });
  const markdown = isMarkdown(file.path);
  const [tab, setTab] = useState<"preview" | "code">(
    markdown ? "preview" : "code"
  );

  let body: ReactNode;
  if (error !== null) {
    body = (
      <p role="alert" className="text-destructive p-4 text-sm">
        {error.message}
      </p>
    );
  } else if (data === undefined) {
    body = <Loading />;
  } else if (data.binary || data.text === undefined) {
    body = (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 p-4">
        <FileText className="size-5" />
        <p className="text-sm">Binary file — {formatBytes(data.size)}</p>
      </div>
    );
  } else {
    body = (
      <div className="flex h-full min-h-0 flex-col">
        {data.truncated ? (
          <p className="bg-warning/15 text-warning border-warning/30 border-b px-3 py-1.5 text-xs">
            Only the first part of this file is shown.
          </p>
        ) : null}
        {markdown && tab === "preview" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <Markdown untrusted>{data.text}</Markdown>
          </div>
        ) : (
          <FileSource text={data.text} language={fileLanguage(file.path)} />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <FileText className="text-muted-foreground size-4 shrink-0" />
        <span
          className="text-ui min-w-0 flex-1 truncate font-medium"
          title={data?.path ?? file.path}
        >
          {data?.path ?? file.path}
        </span>
        {markdown && !(data?.binary ?? false) ? (
          <TabSwitch tab={tab} onTab={setTab} />
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close the file"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
};

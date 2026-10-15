"use client";

import { useQuery } from "@tanstack/react-query";
import type { AttachmentInfo, PreparedAttachment } from "effect-pi/api";
import { CircleAlert, Download, LoaderCircle, ScanText } from "lucide-react";
import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { runApi } from "@/lib/api";
import type { AttachmentRef } from "@/lib/attachments";
import {
  attachmentPageUrl,
  attachmentUrl,
  sizeText,
  statusText,
  tableCells,
} from "@/lib/attachments";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Markdown } from "./markdown";

/** How many rows or pages show before "Show more"; very long files would make the panel slow. */
const STEP = { rows: 200, pages: 20 };

const KIND_LABEL: Record<AttachmentInfo["kind"], string> = {
  text: "Text",
  html: "Web page",
  pdf: "PDF",
  table: "Table",
  image: "Image",
};

const ShowMore = ({
  shown,
  total,
  unit,
  onMore,
}: {
  shown: number;
  total: number;
  unit: string;
  onMore: () => void;
}) =>
  shown >= total ? null : (
    <button
      type="button"
      onClick={onMore}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "self-start"
      )}
    >
      Show more ({shown} of {total} {unit})
    </button>
  );

const TableView = ({ prepared }: { prepared: PreparedAttachment }) => {
  const [limit, setLimit] = useState(STEP.rows);
  const lines = (prepared.pages[0] ?? "").split("\n");
  const [header = "", ...rows] = lines;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted">
            <tr>
              <th className="text-muted-foreground w-10 px-2 py-1.5 text-right font-normal">
                1
              </th>
              {tableCells(header).map((cell, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- columns have no identity beyond their order
                <th key={index} className="px-2 py-1.5 text-left font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((row, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- rows are numbered by position
              <tr key={index} className="border-t">
                <td className="text-muted-foreground px-2 py-1 text-right tabular-nums">
                  {index + 2}
                </td>
                {tableCells(row).map((cell, column) => (
                  <td
                    // oxlint-disable-next-line react/no-array-index-key -- columns have no identity beyond their order
                    key={column}
                    className="px-2 py-1 align-top whitespace-pre-wrap"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ShowMore
        shown={Math.min(limit, rows.length)}
        total={rows.length}
        unit="rows"
        onMore={() => setLimit((current) => current + STEP.rows)}
      />
    </div>
  );
};

/** Which side of a PDF the viewer shows: its pages as they look, or the text the agent reads. */
type PdfMode = "pages" | "text";

const ModeSwitch = ({
  mode,
  onMode,
}: {
  mode: PdfMode;
  onMode: (mode: PdfMode) => void;
}) => (
  <div className="flex gap-1">
    {(
      [
        ["pages", "Pages"],
        ["text", "Text the agent reads"],
      ] as const
    ).map(([value, label]) => (
      <button
        key={value}
        type="button"
        aria-pressed={mode === value}
        onClick={() => onMode(value)}
        className={buttonVariants({
          variant: mode === value ? "secondary" : "ghost",
          size: "sm",
        })}
      >
        {label}
      </button>
    ))}
  </div>
);

const PagesView = ({
  prepared,
  id,
  conversation,
}: {
  prepared: PreparedAttachment;
  id: string;
  conversation: number;
}) => {
  const [limit, setLimit] = useState(STEP.pages);
  const [mode, setMode] = useState<PdfMode>("pages");
  return (
    <div className="flex flex-col gap-4">
      <ModeSwitch mode={mode} onMode={setMode} />
      {prepared.pages.slice(0, limit).map((page, index) => {
        const number = index + 1;
        const scanned = prepared.ocrPages.includes(number);
        return (
          // oxlint-disable-next-line react/no-array-index-key -- pages are numbered by position
          <section key={index} className="flex flex-col gap-1.5">
            <h3 className="text-muted-foreground text-xs font-medium">
              Page {number} of {prepared.pages.length}
            </h3>
            {scanned ? (
              <p className="text-warning flex items-center gap-1.5 text-xs">
                <ScanText aria-hidden className="size-3.5" />
                No text layer: this page is scanned, so the agent cannot read
                it.
              </p>
            ) : null}
            {mode === "pages" ? (
              // oxlint-disable-next-line next/no-img-element -- drawn by our API; the PDF itself is never opened here
              <img
                src={attachmentPageUrl(id, number, conversation)}
                alt={`Page ${number}`}
                loading="lazy"
                className="bg-muted min-h-40 w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              />
            ) : null}
            {mode === "text" && !scanned ? (
              <p className="bg-muted/50 rounded-lg p-3 text-xs whitespace-pre-wrap">
                {page}
              </p>
            ) : null}
          </section>
        );
      })}
      <ShowMore
        shown={Math.min(limit, prepared.pages.length)}
        total={prepared.pages.length}
        unit="pages"
        onMore={() => setLimit((current) => current + STEP.pages)}
      />
    </div>
  );
};

const Contents = ({
  info,
  prepared,
  original,
  conversation,
}: {
  info: AttachmentInfo;
  prepared: PreparedAttachment;
  original: string;
  conversation: number;
}) => {
  switch (prepared.kind) {
    case "image": {
      return (
        // oxlint-disable-next-line next/no-img-element -- a private original from our API
        <img
          src={original}
          alt={info.name}
          className="max-w-full rounded-lg outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        />
      );
    }
    case "table": {
      return <TableView prepared={prepared} />;
    }
    case "pdf": {
      return (
        <PagesView
          prepared={prepared}
          id={info.id}
          conversation={conversation}
        />
      );
    }
    case "text": {
      const text = prepared.pages[0] ?? "";
      return info.mediaType === "text/markdown" ? (
        <div className="text-sm">
          <Markdown>{text}</Markdown>
        </div>
      ) : (
        <p className="bg-muted/50 rounded-lg p-3 text-xs whitespace-pre-wrap">
          {text}
        </p>
      );
    }
    case "html": {
      return (
        <p className="bg-muted/50 rounded-lg p-3 text-xs whitespace-pre-wrap">
          {prepared.pages[0] ?? ""}
        </p>
      );
    }
    default: {
      throw new TypeError(`Unknown kind: ${prepared.kind satisfies never}`);
    }
  }
};

/** What the person learns about the file before its contents: kind, size, and what the model could not read. */
const Details = ({
  info,
  prepared,
}: {
  info: AttachmentInfo;
  prepared: PreparedAttachment;
}) => {
  const parts = [
    KIND_LABEL[info.kind],
    formatBytes(info.size),
    ...(info.pages === undefined ? [] : [`${info.pages} pages`]),
    sizeText(info),
    ...(info.width === undefined || info.height === undefined
      ? []
      : [`${info.width} × ${info.height}`]),
  ].filter((part) => part !== "");
  const status = statusText(info);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{parts.join(" · ")}</p>
      {[...(status === "" ? [] : [status]), ...prepared.warnings].map(
        (warning) => (
          <p
            key={warning}
            className="text-warning flex items-start gap-1.5 text-xs"
          >
            <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {warning}
          </p>
        )
      )}
      {info.kind === "image" || info.kind === "pdf" ? null : (
        <p className="text-muted-foreground text-xs">
          Below is the text the agent reads, not the original layout.
        </p>
      )}
    </div>
  );
};

/** A sent file, opened from its chip: what it is, what the agent reads of it, and a download of the original. */
export const AttachmentViewer = ({
  attachment,
  conversation,
  open,
  onOpenChange,
}: {
  attachment: AttachmentRef;
  conversation: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const original = attachmentUrl(attachment.id, "original", conversation);
  const { data, error, isPending } = useQuery({
    queryKey: ["attachment", conversation, attachment.id],
    queryFn: () =>
      runApi((c) =>
        c.attachments.view({
          params: { id: attachment.id },
          query: { conversation },
        })
      ),
    enabled: open,
    // An attachment never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>
            {/* Clear of the close button; long names wrap. */}
            <span className="block pr-8 break-words">{attachment.name}</span>
          </SheetTitle>
          <SheetDescription className="sr-only">
            The attached file and the text the agent reads from it.
          </SheetDescription>
          <a
            href={original}
            download={attachment.name}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "mt-2 self-start"
            )}
          >
            <Download aria-hidden />
            Download original
          </a>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 px-4 pb-6">
            {isPending ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <LoaderCircle
                  aria-hidden
                  className="size-4 motion-safe:animate-spin"
                />
                Loading…
              </p>
            ) : null}
            {error === null ? null : (
              <p role="alert" className="text-destructive text-sm">
                {error.message}
              </p>
            )}
            {data === undefined ? null : (
              <>
                <Details info={data.info} prepared={data.prepared} />
                <Contents
                  info={data.info}
                  prepared={data.prepared}
                  original={original}
                  conversation={conversation}
                />
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
};

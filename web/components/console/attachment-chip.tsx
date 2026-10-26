"use client";

import {
  CircleAlert,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  ScanText,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type {
  AttachmentKind,
  AttachmentRef,
  DraftAttachment,
} from "@/lib/attachments";
import { attachmentStatus, attachmentUrl, statusText } from "@/lib/attachments";
import { cn } from "@/lib/utils";

import { AttachmentViewer } from "./attachment-viewer";

const KIND_ICON: Record<AttachmentKind, typeof FileText> = {
  text: FileText,
  html: FileCode,
  pdf: FileText,
  table: FileSpreadsheet,
  image: FileImage,
  file: FileArchive,
};

const ChipBody = ({
  icon,
  name,
  status,
  warning,
}: {
  icon: ReactNode;
  name: string;
  status: string;
  /** The status says the model cannot read all of the file. */
  warning: boolean;
}) => (
  <>
    <span aria-hidden className="text-muted-foreground shrink-0 [&_svg]:size-4">
      {icon}
    </span>
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-xs font-medium">{name}</span>
      {status === "" ? null : (
        <span
          className={cn(
            "text-tiny truncate",
            warning ? "text-warning" : "text-muted-foreground"
          )}
        >
          {status}
        </span>
      )}
    </span>
  </>
);

const chipClass =
  "bg-background flex max-w-60 min-w-0 items-center gap-2 rounded-lg border py-1.5 pl-2";

/** A file in the composer, with its upload's status and a button that removes it. */
export const DraftChip = ({
  draft,
  onRemove,
}: {
  draft: DraftAttachment;
  onRemove: () => void;
}) => {
  const failed = draft.state === "failed";
  const Kind =
    draft.state === "uploaded" ? KIND_ICON[draft.info.kind] : FileText;
  let icon: ReactNode = <Kind />;
  if (draft.state === "uploading") {
    icon = <LoaderCircle className="motion-safe:animate-spin" />;
  } else if (failed) {
    icon = <CircleAlert className="text-destructive" />;
  }
  const status = attachmentStatus(draft);
  return (
    <li
      className={cn(chipClass, "pr-1", failed && "border-destructive/40")}
      title={status === "" ? draft.name : `${draft.name}: ${status}`}
    >
      <ChipBody
        icon={icon}
        name={draft.name}
        status={status}
        // A table's size is information; only an unreadable part is a warning.
        warning={
          failed ||
          (draft.state === "uploaded" && draft.info.status !== "ready")
        }
      />
      <button
        type="button"
        aria-label={`Remove ${draft.name}`}
        onClick={onRemove}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring relative ml-auto shrink-0 rounded-md p-1 outline-none after:absolute after:-inset-1.5 focus-visible:ring-2"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  );
};

/** A sent file in the transcript: it opens the viewer (what the agent reads, and the original to download). */
export const SentChip = ({
  attachment,
  conversation,
}: {
  attachment: AttachmentRef;
  /** Unset while the message's Conversation is still being created; the upload is staged. */
  conversation?: number;
}) => {
  const [open, setOpen] = useState(false);
  // The viewer (and its request) exists only once the chip was opened; a transcript has many chips.
  const [opened, setOpened] = useState(false);
  const Kind = KIND_ICON[attachment.kind];
  const status = statusText(attachment);
  const icon =
    attachment.status === "ready" ? (
      <Kind />
    ) : (
      <ScanText className="text-warning" />
    );
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
        title={`View ${attachment.name}`}
        className={cn(
          chipClass,
          "hover:bg-muted focus-visible:ring-ring pr-2.5 text-left outline-none focus-visible:ring-2"
        )}
      >
        {attachment.kind === "image" ? (
          // oxlint-disable-next-line next/no-img-element -- a small private thumbnail from our API
          <img
            src={attachmentUrl(attachment.id, "thumbnail", conversation)}
            alt=""
            className="size-8 shrink-0 rounded object-cover outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          />
        ) : null}
        <ChipBody
          icon={attachment.kind === "image" ? null : icon}
          name={attachment.name}
          status={status}
          warning={status !== ""}
        />
      </button>
      {opened ? (
        <AttachmentViewer
          attachment={attachment}
          conversation={conversation}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
};

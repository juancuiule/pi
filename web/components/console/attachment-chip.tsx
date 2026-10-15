"use client";

import {
  CircleAlert,
  FileCode,
  FileImage,
  FileText,
  LoaderCircle,
  ScanText,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import type {
  AttachmentKind,
  AttachmentRef,
  DraftAttachment,
} from "@/lib/attachments";
import { attachmentStatus, attachmentUrl, statusText } from "@/lib/attachments";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<AttachmentKind, typeof FileText> = {
  text: FileText,
  html: FileCode,
  pdf: FileText,
  image: FileImage,
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
        warning={failed || (draft.state === "uploaded" && status !== "")}
      />
      <button
        type="button"
        aria-label={`Remove ${draft.name}`}
        onClick={onRemove}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 relative ml-auto shrink-0 rounded-md p-1 outline-none after:absolute after:-inset-1.5 focus-visible:ring-2"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  );
};

/** A sent file in the transcript: it downloads the original; an image shows its thumbnail. */
export const SentChip = ({
  attachment,
  conversation,
}: {
  attachment: AttachmentRef;
  conversation: number;
}) => {
  const Kind = KIND_ICON[attachment.kind];
  const status = statusText(attachment);
  const icon =
    attachment.status === "ready" ? (
      <Kind />
    ) : (
      <ScanText className="text-warning" />
    );
  return (
    <a
      href={attachmentUrl(attachment.id, "original", conversation)}
      download={attachment.name}
      title={`Download ${attachment.name}`}
      className={cn(
        chipClass,
        "hover:bg-muted focus-visible:ring-ring/50 pr-2.5 outline-none focus-visible:ring-2"
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
    </a>
  );
};

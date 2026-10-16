"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { attachmentRef, canSend, sendable } from "@/lib/attachments";
import { useTakeDraft } from "@/lib/draft";
import { useSendMessage } from "@/lib/queries";
import { requestIdForSend } from "@/lib/send-request";
import type { FailedSend } from "@/lib/send-request";
import { useConversationStore } from "@/lib/store";
import { useDraftAttachments } from "@/lib/use-draft-attachments";

import { Composer } from "./composer";

const hintFor = (
  running: boolean,
  resuming: boolean,
  paused: boolean
): string => {
  if (running) {
    return "The agent is working. New messages are queued.";
  }
  if (resuming) {
    return "Resuming the conversation — this can take a moment.";
  }
  return paused
    ? "Paused. Sending a message resumes it."
    : "Enter to send · Shift+Enter for a new line";
};

export const MessageInput = ({
  id,
  running,
  resuming = false,
  paused = false,
}: {
  id: number;
  running: boolean;
  /** A resume is in flight; sending waits on it (it queues behind it server-side). */
  resuming?: boolean;
  /** Sending resumes a paused conversation first. */
  paused?: boolean;
}) => {
  const [prompt, setPrompt] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  // A skill picked in the capabilities sheet lands here.
  useTakeDraft(setPrompt, textarea);
  const send = useSendMessage(id);
  const files = useDraftAttachments(id);
  // A failed send kept for its requestId: resending the same message resolves to the same submission.
  const failed = useRef<FailedSend | null>(null);

  const submit = () => {
    if (!canSend(prompt, files.items) || send.isPending) {
      return;
    }
    // Files added while this sends are not part of it, and stay in the composer.
    const { ids, keys, drafts } = sendable(files.items);
    const text = prompt.trim();
    // Names this send's submission; the `submission` event carries it back.
    const requestId = requestIdForSend(failed.current, text, ids);
    // The bubble shows now, marked "Sending…"; the marked "sent" drafts are not deleted when this unmounts.
    useConversationStore.getState().addPending(id, {
      requestId,
      prompt: text,
      attachments: drafts.map((draft) => attachmentRef(draft.info)),
    });
    setPrompt("");
    files.take(keys);
    textarea.current?.focus();
    send.mutate(
      { prompt: text, attachments: ids, requestId },
      {
        onSuccess: (ack) => {
          if (failed.current?.requestId === requestId) {
            failed.current = null;
          }
          useConversationStore.getState().ackPending(id, requestId, ack);
        },
        onError: (error) => {
          failed.current = { requestId, text, attachments: ids };
          // Back to just before Send: the pending bubble goes, the draft — and any text typed since — returns.
          useConversationStore.getState().dropPending(id, requestId);
          setPrompt((current) =>
            current.trim() === "" ? text : `${text}\n\n${current}`
          );
          files.restore(drafts);
          toast.error(error.message);
        },
      }
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <Composer
        prompt={prompt}
        onPrompt={setPrompt}
        onSubmit={submit}
        pending={send.isPending}
        running={running}
        placeholder="Message the agent"
        hint={hintFor(running, resuming, paused)}
        inputRef={textarea}
        attachments={{
          items: files.items,
          onAdd: files.add,
          onRemove: files.remove,
        }}
      />
    </div>
  );
};

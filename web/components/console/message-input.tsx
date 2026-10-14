"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { useTakeDraft } from "@/lib/draft";
import { useSendMessage } from "@/lib/queries";

import { Composer } from "./composer";

const hintFor = (running: boolean, paused: boolean): string => {
  if (running) {
    return "The agent is working. New messages are queued.";
  }
  return paused
    ? "Paused. Sending a message resumes it."
    : "Enter to send · Shift+Enter for a new line";
};

export const MessageInput = ({
  id,
  running,
  paused = false,
}: {
  id: number;
  running: boolean;
  /** Sending resumes a paused conversation first. */
  paused?: boolean;
}) => {
  const [prompt, setPrompt] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  // A skill picked in the capabilities sheet lands here.
  useTakeDraft(setPrompt, textarea);
  const send = useSendMessage(id);

  const submit = () => {
    const text = prompt.trim();
    if (text === "") {
      return;
    }
    send.mutate(text, {
      onSuccess: () => {
        setPrompt("");
        textarea.current?.focus();
      },
      onError: (error) => toast.error(error.message),
    });
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
        hint={hintFor(running, paused)}
        inputRef={textarea}
      />
    </div>
  );
};

"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { useTakeDraft } from "@/lib/draft";
import { useSendMessage } from "@/lib/queries";

import { Composer } from "./composer";

export const MessageInput = ({
  id,
  running,
}: {
  id: number;
  running: boolean;
}) => {
  const [prompt, setPrompt] = useState("");
  // A skill picked in the capabilities sheet lands here.
  useTakeDraft(setPrompt);
  const textarea = useRef<HTMLTextAreaElement>(null);
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
        hint={
          running
            ? "The agent is working. New messages are queued."
            : "Enter to send · Shift+Enter for a new line"
        }
        inputRef={textarea}
      />
    </div>
  );
};

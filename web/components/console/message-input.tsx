"use client";

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSendMessage } from "@/lib/queries";
import { shouldSubmit } from "@/lib/transcript";

export const MessageInput = ({
  id,
  running,
  ended,
}: {
  id: number;
  running: boolean;
  ended: boolean;
}) => {
  const [prompt, setPrompt] = useState("");
  const send = useSendMessage(id);

  const submit = () => {
    const text = prompt.trim();
    if (text === "" || ended) {
      return;
    }
    send.mutate(text, {
      onSuccess: () => setPrompt(""),
      onError: (error) => toast.error(error.message),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      shouldSubmit({ ...event, isComposing: event.nativeEvent.isComposing })
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-end gap-2 border-t p-3">
      <Textarea
        aria-label="Message"
        placeholder="Message the agent"
        disabled={ended}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-h-10"
      />
      <Button
        disabled={ended || send.isPending || prompt.trim() === ""}
        onClick={submit}
      >
        {running ? "Queue" : "Send"}
      </Button>
    </div>
  );
};

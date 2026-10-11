"use client";

import type { SandboxChoice } from "effect-pi/api";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateConversation } from "@/lib/queries";
import { shouldSubmit } from "@/lib/transcript";

const CHOICES: readonly {
  value: SandboxChoice;
  label: string;
  hint: string;
}[] = [
  { value: "none", label: "None", hint: "Chat and subagents, no tools." },
  {
    value: "shell",
    label: "Shell",
    hint: "A Linux container with file and shell tools.",
  },
  {
    value: "desktop",
    label: "Desktop",
    hint: "A Linux desktop the agent can see and control.",
  },
];

export const NewConversation = ({
  onCreated,
}: {
  onCreated: (id: number) => void;
}) => {
  const [sandbox, setSandbox] = useState<SandboxChoice>("none");
  const [prompt, setPrompt] = useState("");
  const create = useCreateConversation();

  const submit = () => {
    const text = prompt.trim();
    if (text === "" || create.isPending) {
      return;
    }
    create.mutate(
      { sandbox, prompt: text },
      {
        onSuccess: (created) => onCreated(created.id),
        onError: (error) => toast.error(error.message),
      }
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      shouldSubmit({ ...event, isComposing: event.nativeEvent.isComposing })
    ) {
      event.preventDefault();
      submit();
    }
  };

  const hint = CHOICES.find((choice) => choice.value === sandbox)?.hint;

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col justify-center gap-4 p-6">
      <h1 className="text-lg font-medium">New conversation</h1>
      <div className="flex flex-col gap-1">
        <Select
          value={sandbox}
          items={CHOICES.map(({ value, label }) => ({ value, label }))}
          onValueChange={(value) => {
            if (value !== null) {
              setSandbox(value);
            }
          }}
        >
          <SelectTrigger aria-label="Sandbox" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHOICES.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-sm">{hint}</p>
      </div>
      <Textarea
        aria-label="Prompt"
        placeholder="What should the agent do?"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button
        className="self-end"
        disabled={create.isPending || prompt.trim() === ""}
        onClick={submit}
      >
        {create.isPending ? "Starting…" : "Start"}
      </Button>
    </div>
  );
};

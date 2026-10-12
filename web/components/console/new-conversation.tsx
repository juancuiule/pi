"use client";

import { Radio } from "@base-ui/react/radio";
import type { SandboxChoice } from "effect-pi/api";
import { Menu } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useTakeDraft } from "@/lib/draft";
import { useCreateConversation, useInfo } from "@/lib/queries";

import { Composer } from "./composer";
import { SANDBOX_INFO } from "./sandbox-badge";

const CHOICES: readonly {
  value: SandboxChoice;
  hint: string;
}[] = [
  { value: "none", hint: "Chat and subagents, no tools." },
  {
    value: "shell",
    hint: "A Linux container with file and shell tools.",
  },
  {
    value: "desktop",
    hint: "A Linux desktop the agent can see and control.",
  },
];

const Kbd = ({ children }: { children: string }) => (
  <kbd className="bg-muted text-tiny rounded border px-1 py-0.5 font-sans">
    {children}
  </kbd>
);

export const NewConversation = ({
  onCreated,
  onMenu,
}: {
  onCreated: (id: number) => void;
  /** Opens the mobile navigation sheet; mobile only. */
  onMenu: () => void;
}) => {
  const [sandbox, setSandbox] = useState<SandboxChoice>("none");
  const [approvals, setApprovals] = useState(true);
  const [prompt, setPrompt] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  // A skill picked in the capabilities sheet lands here.
  useTakeDraft(setPrompt, textarea);
  const create = useCreateConversation();
  const { data: info } = useInfo();

  const submit = () => {
    const text = prompt.trim();
    if (text === "" || create.isPending) {
      return;
    }
    create.mutate(
      // Chat has no gated tools, so no policy is sent for it.
      {
        sandbox,
        prompt: text,
        ...(sandbox === "none"
          ? {}
          : { approvals: approvals ? ("ask" as const) : ("auto" as const) }),
      },
      {
        onSuccess: (created) => onCreated(created.id),
        onError: (error) => toast.error(error.message),
      }
    );
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center gap-5 p-6">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Conversations"
        className="absolute top-3 left-3 md:hidden"
        onClick={onMenu}
      >
        <Menu />
      </Button>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold text-balance">
          What should the agent do?
        </h1>
        {info === undefined ? null : (
          <p className="text-muted-foreground text-sm">Runs on {info.model}</p>
        )}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-muted-foreground mb-2 text-xs font-medium">
          Environment
        </legend>
        <div className="@container">
          <RadioGroup
            aria-label="Environment"
            value={sandbox}
            onValueChange={(value) => setSandbox(value)}
            className="flex flex-col @min-[30rem]:flex-row"
          >
            {CHOICES.map((choice) => {
              const { icon: Icon, label } = SANDBOX_INFO[choice.value];
              return (
                <Radio.Root
                  key={choice.value}
                  value={choice.value}
                  className="focus-visible:border-ring focus-visible:ring-ring/50 data-checked:border-primary data-checked:bg-accent data-checked:ring-primary flex flex-1 cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors duration-150 outline-none focus-visible:ring-3 data-checked:ring-1"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="text-muted-foreground size-4" />
                    {label}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {choice.hint}
                  </span>
                </Radio.Root>
              );
            })}
          </RadioGroup>
        </div>
      </fieldset>
      {sandbox === "none" ? null : (
        <div className="flex items-start gap-3">
          <Switch
            checked={approvals}
            onCheckedChange={setApprovals}
            className="mt-0.5"
            aria-label="Ask before running commands"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">
              Ask before running commands
            </span>
            <span className="text-muted-foreground text-xs">
              You approve each command, file change and desktop action.
            </span>
          </span>
        </div>
      )}
      <Composer
        prompt={prompt}
        onPrompt={setPrompt}
        onSubmit={submit}
        pending={create.isPending}
        tall
        inputRef={textarea}
        placeholder="Describe a task…"
        hint={
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd> to start · <Kbd>Shift+Enter</Kbd> for a new line
          </span>
        }
      />
    </div>
  );
};

"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { Radio } from "@base-ui/react/radio";
import type { SandboxChoice } from "effect-pi/api";
import { ChevronRight, Menu } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useTakeDraft } from "@/lib/draft";
import { useCapabilities, useCreateConversation, useInfo } from "@/lib/queries";
import {
  flip,
  newConversationSettings,
  NO_OVERRIDES,
  settingsPayload,
} from "@/lib/settings";
import type { Overrides } from "@/lib/settings";

import { Composer } from "./composer";
import { SANDBOX_INFO } from "./sandbox-badge";
import { SettingsPanel } from "./settings-panel";

const CHOICES: readonly {
  value: SandboxChoice;
  hint: string;
}[] = [
  { value: "none", hint: "Chat only, no sandbox." },
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
  const { data: capabilities } = useCapabilities();
  // Switches flipped in "Customize", kept across Level changes.
  const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
  const settings =
    capabilities === undefined
      ? undefined
      : newConversationSettings(capabilities, sandbox, overrides);
  const customized =
    settings === undefined ? undefined : settingsPayload(overrides, settings);

  const submit = () => {
    const text = prompt.trim();
    if (text === "" || create.isPending) {
      return;
    }
    create.mutate(
      // Sent for chats too: the agent's upgrade_workspace is gated like commands.
      {
        sandbox,
        prompt: text,
        approvals: approvals ? ("ask" as const) : ("auto" as const),
        ...(customized === undefined ? {} : { settings: customized }),
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
            You approve each command, file change and desktop action, and the
            agent asking for a bigger machine.
          </span>
        </span>
      </div>
      {settings === undefined ? null : (
        <Collapsible.Root>
          <Collapsible.Trigger className="hover:bg-muted focus-visible:ring-ring/50 group text-muted-foreground -mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2">
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90"
            />
            Customize tools and skills
            {customized === undefined ? "" : " · changed"}
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <div className="pt-3">
              <SettingsPanel
                settings={settings}
                onExtension={(name, on) =>
                  setOverrides((current) =>
                    flip(current, "extensions", name, on)
                  )
                }
                onTool={(name, on) =>
                  setOverrides((current) => flip(current, "tools", name, on))
                }
                onSkill={(name, on) =>
                  setOverrides((current) => flip(current, "skills", name, on))
                }
              />
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
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

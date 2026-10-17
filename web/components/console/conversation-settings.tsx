"use client";

// The gear beside a conversation's actions: what this conversation's agent runs with — its model, prompt sections
// and settings — editable per conversation.
import type { SettingsChange } from "effect-pi/api";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  useConfigure,
  useConversationAgent,
  useResetSettings,
} from "@/lib/queries";

import { SettingsPanel } from "./settings-panel";

export const ConversationSettings = ({
  conversationId,
}: {
  conversationId: number;
}) => {
  const [open, setOpen] = useState(false);
  const { data: agent } = useConversationAgent(conversationId, open);
  const configure = useConfigure(conversationId);
  const reset = useResetSettings(conversationId);
  const save = (change: SettingsChange) =>
    configure.mutate(change, {
      onError: (error) => toast.error(error.message),
    });

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Conversation settings"
        title="Conversation settings"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Conversation settings</SheetTitle>
            <SheetDescription>
              What this conversation&rsquo;s agent runs with.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-6 px-4 pb-6">
              {agent === undefined ? null : (
                <section
                  aria-labelledby="agent-heading"
                  className="flex flex-col gap-2"
                >
                  <h3
                    id="agent-heading"
                    className="font-heading text-sm font-semibold"
                  >
                    This conversation
                  </h3>
                  <p className="text-muted-foreground text-xs">
                    {agent.model}
                    {agent.sections.length === 0
                      ? ""
                      : ` · prompt sections: ${agent.sections.join(", ")}`}
                    . Changes apply from the agent&rsquo;s next model request.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      className="self-start"
                      disabled={reset.isPending}
                      onClick={() =>
                        reset.mutate(undefined, {
                          onError: (error) => toast.error(error.message),
                        })
                      }
                    >
                      Reset to defaults
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      className="self-start"
                      disabled={configure.isPending}
                      onClick={() => save({ refreshSkills: "all" })}
                    >
                      Re-sync skills
                    </Button>
                  </div>
                  <SettingsPanel
                    settings={agent}
                    approvals={{
                      ask: agent.approvals === "ask",
                      handleChange: (ask) =>
                        save({ approvals: ask ? "ask" : "auto" }),
                    }}
                    onExtension={(name, on) =>
                      save({ extensions: { [name]: on } })
                    }
                    onTool={(name, on) => save({ tools: { [name]: on } })}
                    onSkill={(name, on) => save({ skills: { [name]: on } })}
                    disabled={configure.isPending}
                  />
                </section>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
};

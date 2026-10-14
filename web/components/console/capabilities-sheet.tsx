"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import type { ToolInfo } from "effect-pi/api";
import { BookOpen, ChevronRight, Plug, ShieldAlert } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { focusAfterSheet, useDraft } from "@/lib/draft";
import { useCapabilities, useConversationAgent } from "@/lib/queries";
import { cn } from "@/lib/utils";

const LEVEL_LABEL = {
  none: "chat",
  shell: "shell",
  desktop: "desktop",
} as const;

const ToolList = ({ tools }: { tools: readonly ToolInfo[] }) => (
  <ul className="flex flex-col gap-1.5 py-1">
    {tools.map((tool) => (
      <li key={tool.name} className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 font-mono text-xs">
          {tool.name}
          {tool.approval ? (
            <span className="text-warning inline-flex items-center gap-0.5 font-sans">
              <ShieldAlert aria-hidden className="size-3" />
              needs approval
            </span>
          ) : null}
        </span>
        {tool.description === "" ? null : (
          <span className="text-muted-foreground line-clamp-3 text-xs">
            {tool.description}
          </span>
        )}
      </li>
    ))}
  </ul>
);

/**
 * The sidebar button and the sheet listing everything the agent can use: what the open conversation runs with,
 * every installed extension, the skills and the MCP servers.
 */
export const CapabilitiesSheet = ({
  conversationId,
}: {
  conversationId: number | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const { data } = useCapabilities();
  const { data: agent } = useConversationAgent(conversationId, open);
  const offer = useDraft((store) => store.offer);
  // Set when the sheet closes because a skill was picked, so focus goes to the composer instead of the trigger.
  const picked = useRef(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => {
          picked.current = false;
          setOpen(true);
        }}
      >
        <Plug />
        Capabilities
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md"
          finalFocus={() =>
            focusAfterSheet(picked.current, useDraft.getState().target?.current)
          }
        >
          <SheetHeader>
            <SheetTitle>Capabilities</SheetTitle>
            <SheetDescription>
              Everything the agent can use: tools, prompt sections, skills and
              MCP servers.
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
                    {agent.model} · extensions: {agent.extensions.join(", ")}
                    {agent.sections.length === 0
                      ? ""
                      : ` · prompt sections: ${agent.sections.join(", ")}`}
                  </p>
                  <ToolList tools={agent.tools} />
                </section>
              )}
              <section
                aria-labelledby="extensions-heading"
                className="flex flex-col gap-2"
              >
                <h3
                  id="extensions-heading"
                  className="font-heading text-sm font-semibold"
                >
                  Extensions
                </h3>
                <ul className="flex flex-col gap-1">
                  {data?.extensions.map((extension) => (
                    <li key={extension.name}>
                      <Collapsible.Root>
                        <Collapsible.Trigger className="hover:bg-muted focus-visible:ring-ring/50 group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2">
                          <ChevronRight
                            aria-hidden
                            className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90"
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">
                              {extension.name}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {extension.levels
                                .map((level) => LEVEL_LABEL[level])
                                .join(", ")}
                              {" · "}
                              {extension.tools.length} tools
                              {extension.sections.length === 0
                                ? ""
                                : ` · prompt: ${extension.sections.join(", ")}`}
                              {extension.hooks === 0
                                ? ""
                                : ` · ${extension.hooks} hooks`}
                            </span>
                          </span>
                        </Collapsible.Trigger>
                        <Collapsible.Panel>
                          <div className="pl-9">
                            {extension.tools.length === 0 ? (
                              <p className="text-muted-foreground py-1 text-xs">
                                No tools.
                              </p>
                            ) : (
                              <ToolList tools={extension.tools} />
                            )}
                          </div>
                        </Collapsible.Panel>
                      </Collapsible.Root>
                    </li>
                  ))}
                </ul>
              </section>
              <section
                aria-labelledby="skills-heading"
                className="flex flex-col gap-2"
              >
                <h3
                  id="skills-heading"
                  className="font-heading text-sm font-semibold"
                >
                  Skills
                </h3>
                {data?.skills.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No skills installed.
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {data?.skills.map((skill) => (
                    <li key={skill.name}>
                      <button
                        type="button"
                        onClick={() => {
                          picked.current = true;
                          offer(`/skill:${skill.name} `);
                          setOpen(false);
                        }}
                        className="hover:bg-muted focus-visible:ring-ring/50 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2"
                      >
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <BookOpen
                            aria-hidden
                            className="text-muted-foreground size-3.5"
                          />
                          {skill.name}
                          {skill.modelInvocable ? null : (
                            <span className="text-muted-foreground text-xs font-normal">
                              · command only
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {skill.description}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section
                aria-labelledby="mcp-heading"
                className="flex flex-col gap-2"
              >
                <h3
                  id="mcp-heading"
                  className="font-heading text-sm font-semibold"
                >
                  MCP servers
                </h3>
                {data?.mcp.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No MCP servers configured.
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {data?.mcp.map((server) => (
                    <li key={server.name}>
                      <Collapsible.Root>
                        <Collapsible.Trigger className="hover:bg-muted focus-visible:ring-ring/50 group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2">
                          <ChevronRight
                            aria-hidden
                            className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90"
                          />
                          <span
                            aria-hidden
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              server.status === "connected"
                                ? "bg-success"
                                : "bg-destructive"
                            )}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">
                              {server.name}
                              <span className="sr-only">
                                {server.status === "connected"
                                  ? ", connected"
                                  : ", unavailable"}
                              </span>
                            </span>
                            <span
                              className="text-muted-foreground truncate font-mono text-xs"
                              title={server.url}
                            >
                              {server.url}
                            </span>
                          </span>
                        </Collapsible.Trigger>
                        <Collapsible.Panel>
                          <div className="pl-9">
                            {server.error === undefined ? null : (
                              <p className="text-destructive py-1 text-xs">
                                {server.error}
                              </p>
                            )}
                            <ul className="flex flex-col gap-1.5 py-1">
                              {server.tools.map((tool) => (
                                <li
                                  key={tool.name}
                                  className="flex flex-col gap-0.5"
                                >
                                  <span className="font-mono text-xs">
                                    {tool.name}
                                  </span>
                                  {tool.description === "" ? null : (
                                    <span className="text-muted-foreground line-clamp-3 text-xs">
                                      {tool.description}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </Collapsible.Panel>
                      </Collapsible.Root>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
};

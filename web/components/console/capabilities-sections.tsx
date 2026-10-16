"use client";

// Sections listing what every conversation can use: the installed extensions and the MCP servers.
import { Collapsible } from "@base-ui/react/collapsible";
import type { Capabilities, ToolInfo } from "effect-pi/api";
import { ChevronRight, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";

export const LEVEL_LABEL = {
  none: "chat",
  shell: "shell",
  desktop: "desktop",
} as const;

export const ToolList = ({ tools }: { tools: readonly ToolInfo[] }) => (
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

/** Every installed extension: its Levels, tools, prompt sections and hooks. */
export const ExtensionsSection = ({
  extensions,
}: {
  extensions: Capabilities["extensions"] | undefined;
}) => (
  <section aria-labelledby="extensions-heading" className="flex flex-col gap-2">
    <h2 id="extensions-heading" className="font-heading text-sm font-semibold">
      Extensions
    </h2>
    <ul className="flex flex-col gap-1">
      {extensions?.map((extension) => (
        <li key={extension.name}>
          <Collapsible.Root>
            <h3 className="text-sm font-medium">
              <Collapsible.Trigger className="hover:bg-muted focus-visible:ring-ring/50 group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2">
                <ChevronRight
                  aria-hidden
                  className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{extension.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {extension.levels
                      .map((level) => LEVEL_LABEL[level])
                      .join(", ")}
                    {" · "}
                    {extension.tools.length} tools
                    {extension.sections.length === 0
                      ? ""
                      : ` · prompt: ${extension.sections.join(", ")}`}
                    {extension.hooks === 0 ? "" : ` · ${extension.hooks} hooks`}
                  </span>
                </span>
              </Collapsible.Trigger>
            </h3>
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
);

/** Every configured MCP server, its status and its tools. */
export const McpServersSection = ({
  mcp,
}: {
  mcp: Capabilities["mcp"] | undefined;
}) => (
  <section aria-labelledby="mcp-heading" className="flex flex-col gap-2">
    <h2 id="mcp-heading" className="font-heading text-sm font-semibold">
      MCP servers
    </h2>
    {mcp?.length === 0 ? (
      <p className="text-muted-foreground text-sm">
        No MCP servers configured.
      </p>
    ) : null}
    <ul className="flex flex-col gap-1">
      {mcp?.map((server) => (
        <li key={server.name}>
          <Collapsible.Root>
            <h3 className="text-sm font-medium">
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
            </h3>
            <Collapsible.Panel>
              <div className="pl-9">
                {server.error === undefined ? null : (
                  <p className="text-destructive py-1 text-xs">
                    {server.error}
                  </p>
                )}
                <ul className="flex flex-col gap-1.5 py-1">
                  {server.tools.map((tool) => (
                    <li key={tool.name} className="flex flex-col gap-0.5">
                      <span className="font-mono text-xs">{tool.name}</span>
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
);

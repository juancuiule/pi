"use client";

import {
  ExtensionsSection,
  McpServersSection,
} from "@/components/console/capabilities-sections";
import { PageHeader } from "@/components/console/page-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCapabilities, useInfo } from "@/lib/queries";

const SettingsPage = () => {
  const { data: info } = useInfo();
  const { data } = useCapabilities();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <title>Settings · effect-pi</title>
      <PageHeader title="Settings" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          <section
            aria-labelledby="model-heading"
            className="flex flex-col gap-2"
          >
            <h2
              id="model-heading"
              className="font-heading text-sm font-semibold"
            >
              Model
            </h2>
            <p
              className="text-muted-foreground truncate font-mono text-xs"
              title={info?.model}
            >
              {info?.model ?? ""}
            </p>
          </section>
          <ExtensionsSection extensions={data?.extensions} />
          <McpServersSection mcp={data?.mcp} />
        </div>
      </ScrollArea>
    </div>
  );
};

export default SettingsPage;

"use client";

import {
  LoaderCircle,
  Monitor,
  Moon,
  Plus,
  ShieldAlert,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/format";
import { useConversations, useInfo } from "@/lib/queries";
import { useMounted } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

import { CapabilitiesSheet } from "./capabilities-sheet";
import { SANDBOX_INFO } from "./sandbox-badge";

/** A clock that re-renders every 30s so relative timestamps stay fresh. */
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

const THEMES = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

const ThemeToggle = () => {
  const { theme, setTheme } = useTheme();
  // next-themes reads the class off <html>; render nothing until mounted or hydration mismatches.
  const mounted = useMounted();
  if (!mounted) {
    return <div className="h-7" />;
  }
  return (
    <fieldset
      aria-label="Theme"
      className="bg-muted flex rounded-lg border-0 p-0.5"
    >
      {THEMES.map(({ value, label, icon: Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger
            render={
              <Toggle
                size="sm"
                aria-label={label}
                pressed={theme === value}
                onPressedChange={() => setTheme(value)}
              >
                <Icon />
              </Toggle>
            }
          />
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </fieldset>
  );
};

export const Sidebar = ({
  selectedId,
  onSelect,
  onNew,
}: {
  selectedId: number | undefined;
  onSelect: (id: number) => void;
  onNew: () => void;
}) => {
  const { data } = useConversations();
  const { data: info } = useInfo();
  const now = useNow();
  const conversations = [...(data ?? [])].toSorted(
    (a, b) => b.createdAt - a.createdAt
  );

  let list: ReactNode;
  if (data === undefined) {
    list = (
      <div className="flex flex-col gap-2 p-1">
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-12 w-full" />
        ))}
      </div>
    );
  } else if (conversations.length === 0) {
    list = (
      <div className="p-2">
        <p className="text-muted-foreground text-sm">No conversations yet</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Start one to see it here.
        </p>
      </div>
    );
  } else {
    list = (
      <nav aria-label="Conversations">
        <ul className="flex flex-col gap-0.5 pb-2">
          {conversations.map((conversation) => {
            const { icon: Icon, label } = SANDBOX_INFO[conversation.sandbox];
            const selected = conversation.id === selectedId;
            const ended = conversation.status === "ended";
            const needsApproval = conversation.pendingApprovals > 0;
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onSelect(conversation.id)}
                  className={cn(
                    "hover:bg-muted focus-visible:ring-ring/50 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2",
                    selected && "bg-accent text-accent-foreground font-medium"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        ended && "text-muted-foreground"
                      )}
                      title={conversation.title}
                    >
                      {conversation.title}
                    </span>
                    {needsApproval ? (
                      <>
                        <ShieldAlert
                          aria-hidden
                          className="text-warning size-3.5 shrink-0"
                        />
                        <span className="sr-only">Needs approval</span>
                      </>
                    ) : null}
                    {conversation.status === "running" && !needsApproval ? (
                      <>
                        <LoaderCircle
                          aria-hidden
                          className="text-muted-foreground size-3.5 shrink-0 motion-safe:animate-spin"
                        />
                        <span className="sr-only">Running</span>
                      </>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Icon className="size-3" />
                    {label}
                    {" · "}
                    {relativeTime(conversation.createdAt, now)}
                    {ended ? " · Ended" : ""}
                    {needsApproval ? " · Needs approval" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="font-heading text-sm font-semibold">effect-pi</span>
      </div>
      <div className="px-2">
        <Button
          variant="outline"
          onClick={onNew}
          className="w-full justify-start"
        >
          <Plus />
          New conversation
        </Button>
      </div>
      <ScrollArea className="mt-2 min-h-0 flex-1">
        <div className="px-2">{list}</div>
      </ScrollArea>
      <div className="border-border flex flex-col gap-1.5 border-t p-2">
        <CapabilitiesSheet />
        <span
          className="text-muted-foreground block truncate font-mono text-xs"
          title={info?.model}
        >
          {info?.model ?? ""}
        </span>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs">Theme</span>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
};

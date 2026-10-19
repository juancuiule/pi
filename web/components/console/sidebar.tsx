"use client";

import type { ConversationSummary } from "effect-pi/api";
import {
  LoaderCircle,
  Monitor,
  Moon,
  Plus,
  Search,
  ShieldAlert,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
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
import { parseConversationId } from "@/lib/conversation-id";
import { relativeTime } from "@/lib/format";
import { PAGES } from "@/lib/navigation";
import { useConversations, useInfo } from "@/lib/queries";
import { useOpenSearch } from "@/lib/search-context";
import { useConversationStore } from "@/lib/store";
import { useMounted } from "@/lib/use-media-query";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

import { SANDBOX_INFO } from "./sandbox-badge";
import { StatusDot } from "./status-dot";

const THEMES = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

/** The spinner a row gets while its Seat is busy: Resuming ahead of Running; neither when an approval waits. */
const activityOf = (
  conversation: ConversationSummary,
  isResuming: boolean
): "Resuming" | "Running" | undefined => {
  if (conversation.pendingApprovals > 0) {
    return undefined;
  }
  if (isResuming) {
    return "Resuming";
  }
  return conversation.status === "running" ? "Running" : undefined;
};

/** The row's trailing status word, e.g. " · Paused"; a resume in flight reads " · Resuming" instead. */
const statusSuffix = (
  conversation: ConversationSummary,
  isResuming: boolean
): string => {
  if (conversation.status === "paused") {
    return isResuming ? " · Resuming" : " · Paused";
  }
  return conversation.status === "archived" ? " · Archived" : "";
};

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

export const Sidebar = () => {
  const router = useRouter();
  const openSearch = useOpenSearch();
  const pathname = usePathname();
  const param = useSearchParams().get("c");
  // A conversation is current only on the chat route.
  const selectedId = pathname === "/" ? parseConversationId(param) : undefined;
  const { data } = useConversations();
  const { data: info } = useInfo();
  const resuming = useConversationStore((store) => store.resuming);
  const ended = useConversationStore((store) => store.ended);
  const now = useNow();
  const [showArchived, setShowArchived] = useState(false);
  const all = [...(data ?? [])].toSorted((a, b) => b.createdAt - a.createdAt);
  const archivedCount = all.filter((c) => c.status === "archived").length;
  // Archived conversations are hidden unless asked for, or unless one is open.
  const conversations = all.filter(
    (c) => showArchived || c.status !== "archived" || c.id === selectedId
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
            const inactive =
              conversation.status === "paused" ||
              conversation.status === "archived";
            const needsApproval = conversation.pendingApprovals > 0;
            const isResuming =
              conversation.status === "paused" &&
              (resuming[conversation.id] ?? 0) > 0;
            const activity = activityOf(conversation, isResuming);
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => router.push(`/?c=${conversation.id}`)}
                  className={cn(
                    "hover:bg-muted focus-visible:ring-ring/50 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2",
                    selected && "bg-accent text-accent-foreground font-medium"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <StatusDot
                      conversation={conversation}
                      ended={ended[conversation.id] === true}
                      resuming={isResuming}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        inactive && "text-muted-foreground"
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
                    {activity === undefined ? null : (
                      <>
                        <LoaderCircle
                          aria-hidden
                          className="text-muted-foreground size-3.5 shrink-0 motion-safe:animate-spin"
                        />
                        <span className="sr-only">{activity}</span>
                      </>
                    )}
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Icon className="size-3" />
                    {label}
                    {" · "}
                    {relativeTime(conversation.createdAt, now)}
                    {statusSuffix(conversation, isResuming)}
                    {conversation.pausing ? " · Pausing" : ""}
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
          onClick={() => router.push("/")}
          className="w-full justify-start"
        >
          <Plus />
          New conversation
        </Button>
        <Button
          variant="ghost"
          onClick={openSearch}
          className="mt-1 w-full justify-start"
        >
          <Search />
          Search
          <kbd className="bg-muted text-tiny text-muted-foreground ml-auto rounded border px-1 py-0.5 font-sans">
            ⌘K
          </kbd>
        </Button>
      </div>
      <ScrollArea className="mt-2 min-h-0 flex-1">
        <div className="px-2">{list}</div>
      </ScrollArea>
      {archivedCount === 0 ? null : (
        <div className="px-2 pb-1">
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-start"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((shown) => !shown)}
          >
            {showArchived
              ? "Hide archived"
              : `Show archived (${archivedCount})`}
          </Button>
        </div>
      )}
      <nav aria-label="Pages" className="border-border border-t px-2 py-2">
        <ul className="flex flex-col gap-0.5">
          {PAGES.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={pathname === href ? "page" : undefined}
                className={cn(
                  "hover:bg-muted focus-visible:ring-ring/50 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150 outline-none focus-visible:ring-2",
                  pathname === href &&
                    "bg-accent text-accent-foreground font-medium"
                )}
              >
                <Icon
                  aria-hidden
                  className="text-muted-foreground size-4 shrink-0"
                />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-border flex flex-col gap-1.5 border-t p-2">
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

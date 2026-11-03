"use client";

// What the console tells the person outside the page: the favicon's badge, and system notifications for
// conversations they are not looking at. Both follow one activity stream for every conversation, which also
// refreshes the conversation list, so dots, favicon and titles move as soon as a Run ends or a call waits —
// even in a background tab, where the list's own polling pauses.
import { useQueryClient } from "@tanstack/react-query";
import type { Activity } from "effect-pi/api";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useEffectEvent } from "react";

import { followActivity } from "@/lib/activity";
import { parseConversationId } from "@/lib/conversation-id";
import { applyFavicon } from "@/lib/favicon";
import {
  notificationOf,
  readPrefs,
  showNotification,
} from "@/lib/notifications";
import { useConsoleSummary } from "@/lib/use-console-summary";

export const ConsoleSignals = () => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const param = useSearchParams().get("c");
  // A conversation is on screen only on the chat route.
  const current = pathname === "/" ? parseConversationId(param) : undefined;

  const { status } = useConsoleSummary();
  useEffect(() => {
    applyFavicon(status);
  }, [status]);
  // Leaving the console (signing out) puts the app's own icon back.
  useEffect(
    () => () => {
      applyFavicon("idle");
    },
    []
  );

  // Reads the conversation on screen when the activity arrives, without reconnecting on every navigation.
  const notify = useEffectEvent((activity: Activity) => {
    const content = notificationOf(activity, {
      prefs: readPrefs(),
      hidden: document.visibilityState === "hidden",
      current,
    });
    if (content !== undefined) {
      showNotification(content, () =>
        router.push(`/?c=${activity.conversation}`)
      );
    }
  });

  useEffect(() => {
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    };
    return followActivity({
      onConnect: refresh,
      onActivity: (activity) => {
        refresh();
        notify(activity);
      },
    });
  }, [queryClient]);

  return null;
};

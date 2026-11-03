// System notifications for the person's conversations: what `GET /api/activity` reports becomes a browser
// Notification when it is useful — the tab is in the background, or the activity is another conversation's than
// the one on screen. The person opts in under Settings; preferences live in this browser only.
import { Option, Schema } from "effect";
import type { Activity } from "effect-pi/api";
import { useSyncExternalStore } from "react";

import { ATTENTION_LABEL } from "./conversation-status";

export type NotifyKind = Activity["kind"];

export const NOTIFY_KINDS: readonly NotifyKind[] = [
  "finished",
  "failed",
  "approval",
  "question",
];

/** Each kind's switch in Settings. */
export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = {
  finished: "An answer is ready",
  failed: "A run failed",
  approval: "A command waits for approval",
  question: "The agent asks you a question",
};

const Prefs = Schema.Struct({
  enabled: Schema.Boolean,
  kinds: Schema.Struct({
    finished: Schema.Boolean,
    failed: Schema.Boolean,
    approval: Schema.Boolean,
    question: Schema.Boolean,
  }),
});
export type NotificationPrefs = typeof Prefs.Type;

/** Off until the person turns them on; then every kind. */
export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: false,
  kinds: { finished: true, failed: true, approval: true, question: true },
};

const PrefsJson = Schema.fromJsonString(Prefs);

/** Stored preferences; anything unreadable is the defaults. */
export const parsePrefs = (raw: string | null): NotificationPrefs =>
  raw === null
    ? DEFAULT_PREFS
    : Option.getOrElse(
        Schema.decodeUnknownOption(PrefsJson)(raw),
        () => DEFAULT_PREFS
      );

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
  /** One per conversation: a newer notification replaces its older one, and two tabs show it once. */
  readonly tag: string;
}

const headline = (activity: Activity): string => {
  switch (activity.kind) {
    case "finished": {
      return "Answer ready";
    }
    case "failed": {
      return activity.attention === undefined
        ? "Run failed"
        : ATTENTION_LABEL[activity.attention.reason];
    }
    case "approval": {
      return "Approval needed";
    }
    case "question": {
      return "A question for you";
    }
    default: {
      return activity.kind satisfies never;
    }
  }
};

const detailOf = (activity: Activity): string | undefined => {
  if (activity.kind === "failed") {
    return activity.attention?.detail;
  }
  return activity.kind === "approval" && activity.tool !== undefined
    ? `Wants to run ${activity.tool}`
    : undefined;
};

/**
 * The notification `activity` earns, or `undefined`: none while they are off or the kind is, and none for the
 * conversation on screen in a visible tab — the person is already looking at it.
 */
export const notificationOf = (
  activity: Activity,
  context: {
    readonly prefs: NotificationPrefs;
    readonly hidden: boolean;
    /** The conversation on screen, if any. */
    readonly current: number | undefined;
  }
): NotificationContent | undefined => {
  const { prefs, hidden, current } = context;
  if (!prefs.enabled || !prefs.kinds[activity.kind]) {
    return undefined;
  }
  if (!hidden && activity.conversation === current) {
    return undefined;
  }
  const detail = detailOf(activity);
  return {
    title: headline(activity),
    body:
      detail === undefined ? activity.title : `${activity.title}\n${detail}`,
    tag: `conversation-${activity.conversation}`,
  };
};

// The browser side: preferences in localStorage, shared by every tab and the Settings switches.

const STORAGE_KEY = "effect-pi.notifications";
const listeners = new Set<() => void>();
let cached: { readonly raw: string | null; readonly prefs: NotificationPrefs } =
  { raw: null, prefs: DEFAULT_PREFS };

const readRaw = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/** The stored preferences, the same object while they are unchanged (for `useSyncExternalStore`). */
export const readPrefs = (): NotificationPrefs => {
  const raw = readRaw();
  if (raw !== cached.raw) {
    cached = { raw, prefs: parsePrefs(raw) };
  }
  return cached.prefs;
};

export const writePrefs = (prefs: NotificationPrefs): void => {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      Schema.encodeSync(PrefsJson)(prefs)
    );
  } catch {
    // Storage blocked: the switch does not stick, nothing else breaks.
  }
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another tab's change arrives as a storage event.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};

export const useNotificationPrefs = (): NotificationPrefs =>
  useSyncExternalStore(subscribe, readPrefs, () => DEFAULT_PREFS);

/** `unsupported`: no Notification API, or not a secure context (plain http off loopback). */
export type NotificationSupport = NotificationPermission | "unsupported";

export const notificationSupport = (): NotificationSupport =>
  typeof window === "undefined" ||
  !("Notification" in window) ||
  !window.isSecureContext
    ? "unsupported"
    : Notification.permission;

/**
 * Show `content`; a click focuses the console and opens the conversation. Some browsers (Chrome on Android)
 * refuse `new Notification` outside a service worker; then nothing is shown.
 */
export const showNotification = (
  content: NotificationContent,
  onClick: () => void
): void => {
  if (notificationSupport() !== "granted") {
    return;
  }
  try {
    const shown = new Notification(content.title, {
      body: content.body,
      tag: content.tag,
    });
    shown.addEventListener("click", () => {
      window.focus();
      onClick();
      shown.close();
    });
  } catch {
    // No page-level notifications in this browser.
  }
};

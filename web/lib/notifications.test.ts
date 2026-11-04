import type { Activity } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFS, notificationOf, parsePrefs } from "./notifications";

const on = { ...DEFAULT_PREFS, enabled: true };

const activity = (overrides: Partial<Activity> = {}): Activity => ({
  conversation: 7,
  title: "Plan the trip",
  kind: "finished",
  at: 0,
  ...overrides,
});

describe(notificationOf, () => {
  it("says what happened, names the conversation, and tags it by conversation", () => {
    expect(
      notificationOf(activity(), { prefs: on, hidden: true, current: 7 })
    ).toStrictEqual({
      title: "Answer ready",
      body: "Plan the trip",
      tag: "conversation-7",
    });
    expect(
      notificationOf(
        activity({
          kind: "failed",
          attention: { reason: "model_error", detail: "overloaded" },
        }),
        { prefs: on, hidden: true, current: undefined }
      )
    ).toMatchObject({
      title: "Model error",
      body: "Plan the trip\noverloaded",
    });
    expect(
      notificationOf(activity({ kind: "approval", tool: "bash" }), {
        prefs: on,
        hidden: true,
        current: undefined,
      })
    ).toMatchObject({
      title: "Approval needed",
      body: "Plan the trip\nWants to run bash",
    });
    expect(
      notificationOf(activity({ kind: "question", tool: "ask_user" }), {
        prefs: on,
        hidden: true,
        current: undefined,
      })
    ).toMatchObject({ title: "A question for you", body: "Plan the trip" });
  });

  it("stays quiet for the conversation on screen in a visible tab, not for another one", () => {
    expect(
      notificationOf(activity(), { prefs: on, hidden: false, current: 7 })
    ).toBeUndefined();
    expect(
      notificationOf(activity(), { prefs: on, hidden: false, current: 8 })
    ).toBeDefined();
    expect(
      notificationOf(activity(), {
        prefs: on,
        hidden: false,
        current: undefined,
      })
    ).toBeDefined();
  });

  it("stays quiet while turned off, or for a kind switched off", () => {
    expect(
      notificationOf(activity(), {
        prefs: DEFAULT_PREFS,
        hidden: true,
        current: undefined,
      })
    ).toBeUndefined();
    expect(
      notificationOf(activity(), {
        prefs: { ...on, kinds: { ...on.kinds, finished: false } },
        hidden: true,
        current: undefined,
      })
    ).toBeUndefined();
  });
});

describe(parsePrefs, () => {
  it("reads stored preferences, and the defaults for anything unreadable", () => {
    expect(parsePrefs(JSON.stringify(on))).toStrictEqual(on);
    expect(parsePrefs(null)).toStrictEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toStrictEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"enabled":true}')).toStrictEqual(DEFAULT_PREFS);
  });
});

// Artifacts in the console: sandboxed HTML pages the agent writes (docs/plans/artifacts.md). A committed
// `artifact_create`/`artifact_update` result carries `{ id, version, title }` in its `details` — the card and the
// panel read it from there, the way `patchOf` reads an edit's patch.
import type { ConversationSummary, EntryRecord } from "effect-pi/api";

import { parseConversationId } from "./conversation-id";
import { relativeTime } from "./format";

/** The artifact a committed `artifact_*` result points at. */
export interface ArtifactRef {
  readonly id: string;
  readonly version: number;
  readonly title: string;
}

/** The artifact open beside the chat; `version` unset follows the latest. */
export interface OpenArtifact {
  readonly id: string;
  readonly version?: number | undefined;
}

/** What the console's artifact panel shows: nothing, the conversation's list, or one artifact. */
export type ArtifactPanelState =
  | { readonly kind: "closed" }
  | { readonly kind: "list" }
  | { readonly kind: "artifact"; readonly artifact: OpenArtifact };

export type ArtifactPanelAction =
  | { readonly type: "toggle" }
  | { readonly type: "open"; readonly artifact: OpenArtifact }
  | { readonly type: "back" }
  | { readonly type: "close" };

export const ARTIFACT_PANEL_CLOSED: ArtifactPanelState = { kind: "closed" };

/**
 * The header button toggles between closed and the list, and closes an open artifact too; `open` shows one
 * artifact from anywhere; `back` returns from an artifact to the list.
 */
export const nextArtifactPanel = (
  state: ArtifactPanelState,
  action: ArtifactPanelAction
): ArtifactPanelState => {
  switch (action.type) {
    case "toggle": {
      return state.kind === "closed" ? { kind: "list" } : ARTIFACT_PANEL_CLOSED;
    }
    case "open": {
      return { kind: "artifact", artifact: action.artifact };
    }
    case "back": {
      return state.kind === "artifact" ? { kind: "list" } : state;
    }
    case "close": {
      return ARTIFACT_PANEL_CLOSED;
    }
    default: {
      return state;
    }
  }
};

/** A list row's detail: "1 version · just now", "3 versions · 2h ago". */
export const artifactRowDetail = (
  artifact: {
    readonly versions: readonly unknown[];
    readonly updatedAt: number;
  },
  now: number
): string => {
  const count = artifact.versions.length;
  return `${count} ${count === 1 ? "version" : "versions"} · ${relativeTime(artifact.updatedAt, now)}`;
};

/** The ref in a tool result's `details`, when it is one. */
export const artifactOf = (details: unknown): ArtifactRef | undefined => {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const { id, version, title } = details as Record<string, unknown>;
  return typeof id === "string" &&
    typeof version === "number" &&
    Number.isInteger(version) &&
    typeof title === "string"
    ? { id, version, title }
    : undefined;
};

/** Where the iframe and the new-tab link get a version's page; its own response CSP sandboxes it. */
export const artifactRenderUrl = (
  conversation: number,
  id: string,
  version?: number
): string =>
  `/api/artifacts/${encodeURIComponent(id)}/render?conversation=${conversation}${
    version === undefined ? "" : `&v=${version}`
  }`;

/** The `/artifacts` URL that opens an artifact in the page's own panel; `version` pins the shown version. */
export const artifactUrl = (
  conversation: number,
  id: string,
  version?: number
): string =>
  `/artifacts?c=${conversation}&artifact=${encodeURIComponent(id)}${
    version === undefined ? "" : `&v=${version}`
  }`;

/**
 * The artifact `/artifacts?c=<conversation>&artifact=<id>[&v]` names, when `c` is an integer and `artifact` is
 * non-empty; an absent or non-integer `v` leaves `version` unset, following the latest.
 */
export const openArtifactOf = (params: {
  get(name: string): string | null;
}): { artifact: OpenArtifact; conversation: number } | undefined => {
  const conversation = parseConversationId(params.get("c"));
  const id = params.get("artifact");
  if (conversation === undefined || id === null || id === "") {
    return undefined;
  }
  const v = params.get("v");
  const version = v === null ? undefined : Number(v);
  return {
    conversation,
    artifact:
      version !== undefined && Number.isInteger(version)
        ? { id, version }
        : { id },
  };
};

/** A conversation's title, or `#<id>` when it is not in the loaded list. */
export const conversationTitleOf = (
  conversations: readonly ConversationSummary[] | undefined,
  id: number
): string => conversations?.find((each) => each.id === id)?.title ?? `#${id}`;

/**
 * The newest committed `artifact_*` tool result in the transcript, tagged with its call id so the console opens
 * the panel once per call, not again on every later event.
 */
export const latestArtifactCall = (
  entries: readonly EntryRecord[]
): (ArtifactRef & { readonly callId: string }) | undefined => {
  let latest: (ArtifactRef & { readonly callId: string }) | undefined;
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (
        message.role === "toolResult" &&
        message.toolName.startsWith("artifact_")
      ) {
        const ref = artifactOf(message.details);
        if (ref !== undefined) {
          latest = { ...ref, callId: message.toolCallId };
        }
      }
    }
  }
  return latest;
};

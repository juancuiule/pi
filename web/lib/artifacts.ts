// Artifacts in the console: sandboxed HTML pages the agent writes (docs/plans/artifacts.md). A committed
// `artifact_create`/`artifact_update` result carries `{ id, version, title }` in its `details` — the card and the
// panel read it from there, the way `patchOf` reads an edit's patch.
import type { EntryRecord } from "effect-pi/api";

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

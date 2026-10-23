import type { ConversationSummary, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import {
  artifactOf,
  artifactRenderUrl,
  artifactRowDetail,
  artifactUrl,
  conversationTitleOf,
  latestArtifactCall,
  nextArtifactPanel,
  openArtifactOf,
} from "./artifacts";
import type { ArtifactPanelAction, ArtifactPanelState } from "./artifacts";

const toolResult = (
  callId: string,
  toolName: string,
  details?: unknown
): unknown => ({
  role: "toolResult",
  toolCallId: callId,
  toolName,
  content: [],
  details,
  isError: false,
  timestamp: 0,
});

const entry = (id: number, message: unknown): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "test",
    model: [message],
  }) as unknown as EntryRecord;

describe(artifactOf, () => {
  it("parses the details an artifact_* result carries", () => {
    expect(
      artifactOf({ id: "art_abc", version: 2, title: "Report" })
    ).toStrictEqual({ id: "art_abc", version: 2, title: "Report" });
  });

  it("rejects anything that is not the ref shape", () => {
    for (const details of [
      undefined,
      null,
      "x",
      42,
      {},
      { id: 1, version: 2, title: "x" },
      { id: "art_abc", version: "2", title: "x" },
      { id: "art_abc", version: 1 },
      { id: "art_abc", version: 1.5, title: "x" },
      { version: 1, title: "x" },
    ]) {
      expect(artifactOf(details)).toBeUndefined();
    }
  });
});

describe(latestArtifactCall, () => {
  it("returns the newest committed artifact_* result with its call id", () => {
    const entries = [
      entry(
        1,
        toolResult("c1", "artifact_create", {
          id: "art_a",
          version: 1,
          title: "A",
        })
      ),
      entry(2, { role: "assistant", content: [] }),
      entry(
        3,
        toolResult("c2", "artifact_update", {
          id: "art_a",
          version: 2,
          title: "A",
        })
      ),
      entry(
        4,
        toolResult("c3", "read", { id: "art_x", version: 9, title: "no" })
      ),
    ];
    expect(latestArtifactCall(entries)).toStrictEqual({
      id: "art_a",
      version: 2,
      title: "A",
      callId: "c2",
    });
  });

  it("ignores results without a ref, like a failed call's", () => {
    const entries = [
      entry(1, toolResult("c1", "artifact_create")),
      entry(2, toolResult("c2", "artifact_update", { error: "no such id" })),
    ];
    expect(latestArtifactCall(entries)).toBeUndefined();
  });

  it("reads multiple results in one entry", () => {
    const combined = {
      ...entry(
        1,
        toolResult("c1", "artifact_create", {
          id: "art_a",
          version: 1,
          title: "A",
        })
      ),
      model: [
        toolResult("c1", "artifact_create", {
          id: "art_a",
          version: 1,
          title: "A",
        }),
        toolResult("c2", "artifact_update", {
          id: "art_a",
          version: 2,
          title: "A",
        }),
      ],
    } as unknown as EntryRecord;
    expect(latestArtifactCall([combined])?.callId).toBe("c2");
  });
});

describe(artifactRenderUrl, () => {
  it("builds the same-origin render URL, versioned or latest", () => {
    expect(artifactRenderUrl(3, "art_abc")).toBe(
      "/api/artifacts/art_abc/render?conversation=3"
    );
    expect(artifactRenderUrl(3, "art_abc", 2)).toBe(
      "/api/artifacts/art_abc/render?conversation=3&v=2"
    );
  });
});

describe(artifactUrl, () => {
  it("builds the /artifacts URL, versioned or latest", () => {
    expect(artifactUrl(3, "art_abc")).toBe("/artifacts?c=3&artifact=art_abc");
    expect(artifactUrl(3, "art_abc", 2)).toBe(
      "/artifacts?c=3&artifact=art_abc&v=2"
    );
  });

  it("encodes the id", () => {
    expect(artifactUrl(1, "a/b?c")).toBe("/artifacts?c=1&artifact=a%2Fb%3Fc");
  });
});

const params = (entries: Record<string, string>) =>
  new URLSearchParams(entries);

describe(openArtifactOf, () => {
  it("reads the c and artifact pair, v optionally", () => {
    expect(
      openArtifactOf(params({ c: "3", artifact: "art_abc" }))
    ).toStrictEqual({ conversation: 3, artifact: { id: "art_abc" } });
    expect(
      openArtifactOf(params({ c: "3", artifact: "art_abc", v: "2" }))
    ).toStrictEqual({
      conversation: 3,
      artifact: { id: "art_abc", version: 2 },
    });
  });

  it("is undefined without both c and artifact, c being an integer", () => {
    expect(openArtifactOf(params({ artifact: "art_abc" }))).toBeUndefined();
    expect(openArtifactOf(params({ c: "3" }))).toBeUndefined();
    expect(
      openArtifactOf(params({ c: "x", artifact: "art_abc" }))
    ).toBeUndefined();
    expect(
      openArtifactOf(params({ c: "3.5", artifact: "art_abc" }))
    ).toBeUndefined();
    expect(openArtifactOf(params({ c: "3", artifact: "" }))).toBeUndefined();
  });

  it("treats a bad v as absent", () => {
    expect(
      openArtifactOf(params({ c: "3", artifact: "art_abc", v: "x" }))
    ).toStrictEqual({ conversation: 3, artifact: { id: "art_abc" } });
  });
});

const summary = (id: number, title: string): ConversationSummary => ({
  id,
  sandbox: "none",
  software: [],
  title,
  status: "idle",
  pausing: false,
  pendingApprovals: 0,
  createdAt: 0,
});

describe(conversationTitleOf, () => {
  it("returns the conversation's title, or #id when it is not listed", () => {
    const conversations = [summary(3, "Report"), summary(7, "Chart")];
    expect(conversationTitleOf(conversations, 7)).toBe("Chart");
    expect(conversationTitleOf(conversations, 4)).toBe("#4");
    expect(conversationTitleOf(undefined, 4)).toBe("#4");
  });
});

describe(nextArtifactPanel, () => {
  const page = { id: "art_a", version: 2 };
  const other = { id: "art_b" };
  const closed: ArtifactPanelState = { kind: "closed" };
  const list: ArtifactPanelState = { kind: "list" };
  const open: ArtifactPanelState = { kind: "artifact", artifact: page };

  it.each<
    [string, ArtifactPanelState, ArtifactPanelAction, ArtifactPanelState]
  >([
    ["the button opens the list", closed, { type: "toggle" }, list],
    ["the button closes the list", list, { type: "toggle" }, closed],
    ["the button closes an open artifact", open, { type: "toggle" }, closed],
    [
      "a row opens its artifact over the list",
      list,
      { type: "open", artifact: page },
      open,
    ],
    [
      "a new page opens a closed panel on it",
      closed,
      { type: "open", artifact: page },
      open,
    ],
    [
      "a new page replaces the open one",
      open,
      { type: "open", artifact: other },
      { kind: "artifact", artifact: other },
    ],
    ["back returns to the list", open, { type: "back" }, list],
    ["back on the list stays", list, { type: "back" }, list],
    ["back on a closed panel stays closed", closed, { type: "back" }, closed],
    ["close closes an artifact", open, { type: "close" }, closed],
    ["close closes the list", list, { type: "close" }, closed],
  ])("%s", (_, state, action, next) => {
    expect(nextArtifactPanel(state, action)).toStrictEqual(next);
  });
});

describe(artifactRowDetail, () => {
  const now = Date.UTC(2026, 0, 10, 12);

  it("counts versions and says when the page last changed", () => {
    expect(
      artifactRowDetail({ versions: [1], updatedAt: now - 10_000 }, now)
    ).toBe("1 version · just now");
    expect(
      artifactRowDetail(
        { versions: [1, 2, 3], updatedAt: now - 2 * 3_600_000 },
        now
      )
    ).toBe("3 versions · 2h ago");
  });
});

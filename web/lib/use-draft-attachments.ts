"use client";

import { useEffect, useRef, useState } from "react";

import { runApi } from "./api";
import type { DraftAttachment } from "./attachments";

const upload = (file: File, conversation: number | undefined) => {
  const payload = new FormData();
  payload.append("file", file, file.name);
  if (conversation !== undefined) {
    payload.append("conversation", String(conversation));
  }
  return runApi((c) => c.attachments.upload({ payload }));
};

/** Delete an unsent upload; the server refuses sent ones, and one that cannot be deleted now expires anyway. */
const forget = async (id: string) => {
  try {
    await runApi((c) => c.attachments.remove({ params: { id } }));
  } catch {
    // It expires with the other unsent uploads.
  }
};

type Drafts = Readonly<Record<string, readonly DraftAttachment[]>>;

const scopeOf = (conversation: number | undefined) =>
  conversation === undefined ? "new" : String(conversation);

/**
 * The files in a composer, per conversation (a switch keeps each one's files): each is uploaded as soon as it is
 * added (staged, or to `conversation`). Removing one deletes its upload, even one still uploading; so does leaving
 * the composer with files never sent. `take` drops the files a message sent, keeping any added since.
 */
export const useDraftAttachments = (conversation?: number) => {
  const scope = scopeOf(conversation);
  const [drafts, setDrafts] = useState<Drafts>({});
  const items = drafts[scope] ?? [];
  const counter = useRef(0);
  // Keys removed while uploading, whose upload is deleted when it lands; and keys sent, never deleted.
  const removed = useRef(new Set<string>());
  const sent = useRef(new Set<string>());
  const mounted = useRef(true);
  // The drafts as last rendered, for the cleanup when the composer goes away.
  const latest = useRef<Drafts>(drafts);
  useEffect(() => {
    latest.current = drafts;
  });

  useEffect(() => {
    mounted.current = true;
    const removedKeys = removed.current;
    const sentKeys = sent.current;
    return () => {
      mounted.current = false;
      for (const draft of Object.values(latest.current).flat()) {
        if (draft.state === "uploaded" && !sentKeys.has(draft.key)) {
          void forget(draft.info.id);
        }
        removedKeys.add(draft.key);
      }
    };
  }, []);

  const change = (
    at: string,
    edit: (current: readonly DraftAttachment[]) => readonly DraftAttachment[]
  ) => setDrafts((current) => ({ ...current, [at]: edit(current[at] ?? []) }));

  const uploadOne = async (at: string, key: string, file: File) => {
    try {
      const info = await upload(file, conversation);
      if (removed.current.has(key) || !mounted.current) {
        await forget(info.id);
        return;
      }
      change(at, (current) =>
        current.map((item) =>
          item.key === key
            ? { key, name: file.name, state: "uploaded", info }
            : item
        )
      );
    } catch (error) {
      change(at, (current) =>
        current.map((item) =>
          item.key === key
            ? {
                key,
                name: file.name,
                state: "failed",
                error: error instanceof Error ? error.message : String(error),
              }
            : item
        )
      );
    }
  };

  const add = (files: readonly File[]) => {
    const added = files.map((file) => {
      counter.current += 1;
      return { key: `f${counter.current}`, file };
    });
    change(scope, (current) => [
      ...current,
      ...added.map(({ key, file }): DraftAttachment => ({
        key,
        name: file.name,
        state: "uploading",
      })),
    ]);
    for (const { key, file } of added) {
      void uploadOne(scope, key, file);
    }
  };

  const remove = (key: string) => {
    const draft = items.find((item) => item.key === key);
    removed.current.add(key);
    change(scope, (current) => current.filter((item) => item.key !== key));
    if (draft?.state === "uploaded") {
      void forget(draft.info.id);
    }
  };

  /** Drop the files a message sent; files added while it was sending stay. */
  const take = (keys: readonly string[]) => {
    for (const key of keys) {
      sent.current.add(key);
    }
    change(scope, (current) =>
      current.filter((item) => !keys.includes(item.key))
    );
  };

  return { items, add, remove, take };
};

"use client";

import { useEffect, useRef, useState } from "react";

import { isGenericRequestFailure, runApi } from "./api";
import type { DraftAttachment } from "./attachments";

const upload = (file: File, conversation: number | undefined) => {
  const payload = new FormData();
  payload.append("file", file, file.name);
  if (conversation !== undefined) {
    payload.append("conversation", String(conversation));
  }
  return runApi((c) => c.attachments.upload({ payload }));
};

/** A failed upload's status on its chip: the server's reason when it gave one, else how to retry. */
const uploadFailure = (error: unknown): string => {
  if (isGenericRequestFailure(error)) {
    return "Couldn't upload the file. Remove it and try again.";
  }
  return error instanceof Error ? error.message : String(error);
};

/** Delete an unsent upload; the server refuses sent ones, and one that cannot be deleted now expires anyway. */
const forget = async (id: string) => {
  try {
    await runApi((c) => c.attachments.remove({ params: { id } }));
  } catch {
    // It expires with the other unsent uploads.
  }
};

/**
 * The files in a composer: each is uploaded as soon as it is added (staged, or to `conversation`). Removing one
 * deletes its upload, even one still uploading. The page remounts the composer for each conversation, so, like the
 * typed draft, files do not survive a switch: leaving deletes the uploads never sent. `take` drops the files a
 * message sent, keeping any added since.
 */
export const useDraftAttachments = (conversation?: number) => {
  const [items, setItems] = useState<readonly DraftAttachment[]>([]);
  const counter = useRef(0);
  // Keys removed while uploading, whose upload is deleted when it lands; and keys sent, never deleted.
  const removed = useRef(new Set<string>());
  const sent = useRef(new Set<string>());
  const mounted = useRef(true);
  // The drafts as last rendered, for the cleanup when the composer goes away.
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });

  useEffect(() => {
    mounted.current = true;
    const removedKeys = removed.current;
    const sentKeys = sent.current;
    return () => {
      mounted.current = false;
      for (const draft of latest.current) {
        if (draft.state === "uploaded" && !sentKeys.has(draft.key)) {
          void forget(draft.info.id);
        }
        removedKeys.add(draft.key);
      }
    };
  }, []);

  const replace = (key: string, next: DraftAttachment) =>
    setItems((current) =>
      current.map((item) => (item.key === key ? next : item))
    );

  const uploadOne = async (key: string, file: File) => {
    try {
      const info = await upload(file, conversation);
      if (removed.current.has(key) || !mounted.current) {
        await forget(info.id);
        return;
      }
      replace(key, { key, name: file.name, state: "uploaded", info });
    } catch (error) {
      replace(key, {
        key,
        name: file.name,
        state: "failed",
        error: uploadFailure(error),
      });
    }
  };

  const add = (files: readonly File[]) => {
    const added = files.map((file) => {
      counter.current += 1;
      return { key: `f${counter.current}`, file };
    });
    setItems((current) => [
      ...current,
      ...added.map(({ key, file }): DraftAttachment => ({
        key,
        name: file.name,
        state: "uploading",
      })),
    ]);
    for (const { key, file } of added) {
      void uploadOne(key, file);
    }
  };

  const remove = (key: string) => {
    const draft = items.find((item) => item.key === key);
    removed.current.add(key);
    setItems((current) => current.filter((item) => item.key !== key));
    if (draft?.state === "uploaded") {
      void forget(draft.info.id);
    }
  };

  /** Drop the files a message sent; files added while it was sending stay. */
  const take = (keys: readonly string[]) => {
    for (const key of keys) {
      sent.current.add(key);
    }
    setItems((current) => current.filter((item) => !keys.includes(item.key)));
  };

  /** Put back drafts a failed send took, ahead of any added since; they are unsent uploads again. */
  const restore = (drafts: readonly DraftAttachment[]) => {
    for (const draft of drafts) {
      sent.current.delete(draft.key);
      removed.current.delete(draft.key);
    }
    setItems((current) => [
      ...drafts.filter((draft) =>
        current.every((item) => item.key !== draft.key)
      ),
      ...current,
    ]);
  };

  return { items, add, remove, take, restore };
};

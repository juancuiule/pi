"use client";

import { useRef, useState } from "react";

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

/** Delete an unsent upload; one that cannot be deleted now expires anyway. */
const forget = async (id: string) => {
  try {
    await runApi((c) => c.attachments.remove({ params: { id } }));
  } catch {
    // It expires with the other unsent uploads.
  }
};

/**
 * The files in a composer: each is uploaded as soon as it is added (staged, or to `conversation`), and removing one
 * deletes the upload. The list belongs to one conversation; switching conversations starts an empty one.
 */
export const useDraftAttachments = (conversation?: number) => {
  const [drafts, setDrafts] = useState<{
    readonly conversation: number | undefined;
    readonly items: readonly DraftAttachment[];
  }>({ conversation, items: [] });
  const items = drafts.conversation === conversation ? drafts.items : [];
  const counter = useRef(0);

  // Change this conversation's list; a list left behind by a switch is not touched.
  const change = (
    edit: (current: readonly DraftAttachment[]) => readonly DraftAttachment[]
  ) =>
    setDrafts((current) =>
      current.conversation === conversation
        ? { conversation, items: edit(current.items) }
        : current
    );
  const replace = (key: string, next: DraftAttachment) =>
    change((current) =>
      current.map((item) => (item.key === key ? next : item))
    );
  const drop = (key: string) =>
    change((current) => current.filter((item) => item.key !== key));

  const uploadOne = async (key: string, file: File) => {
    try {
      const info = await upload(file, conversation);
      replace(key, { key, name: file.name, state: "uploaded", info });
    } catch (error) {
      replace(key, {
        key,
        name: file.name,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const add = (files: readonly File[]) => {
    const added = files.map((file) => {
      counter.current += 1;
      return { key: `f${counter.current}`, file };
    });
    setDrafts((current) => ({
      conversation,
      items: [
        ...(current.conversation === conversation ? current.items : []),
        ...added.map(({ key, file }): DraftAttachment => ({
          key,
          name: file.name,
          state: "uploading",
        })),
      ],
    }));
    for (const { key, file } of added) {
      void uploadOne(key, file);
    }
  };

  const remove = (key: string) => {
    const draft = items.find((item) => item.key === key);
    drop(key);
    if (draft?.state === "uploaded") {
      void forget(draft.info.id);
    }
  };

  /** Empty the list once its files were sent. */
  const clear = () => setDrafts({ conversation, items: [] });

  return { items, add, remove, clear };
};

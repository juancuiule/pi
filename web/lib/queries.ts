"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApprovalChoice,
  ConversationSummary,
  SandboxChoice,
  SettingsChange,
} from "effect-pi/api";

import { runApi } from "./api";
import type { CapacityGuard } from "./capacity-context";
import { useCapacityGuard } from "./capacity-context";
import { useConversationStore } from "./store";

const LIST = ["conversations"] as const;

export const useConversations = () =>
  useQuery({
    queryKey: LIST,
    queryFn: () => runApi((c) => c.conversations.list()),
    // Keeps status dots current; each open conversation's events are live anyway.
    refetchInterval: 2000,
  });

export const useInfo = () =>
  useQuery({
    queryKey: ["info"],
    queryFn: () => runApi((c) => c.info.get()),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useCapabilities = () =>
  useQuery({
    queryKey: ["capabilities"],
    queryFn: () => runApi((c) => c.info.capabilities()),
    // MCP servers connect once, at server start; reloading the page refetches.
    staleTime: Number.POSITIVE_INFINITY,
  });

/** What one conversation runs with now; fetched while `enabled`, e.g. while the Capabilities sheet is open. */
export const useConversationAgent = (
  id: number | undefined,
  enabled: boolean
) =>
  useQuery({
    queryKey: ["agent", id],
    queryFn: () =>
      runApi((c) => c.conversations.agent({ params: { id: id ?? 0 } })),
    enabled: enabled && id !== undefined,
    // The agent changes its own settings too (an Upgrade), and so can another tab.
    refetchInterval: 2000,
  });

/** Put a conversation's settings back to its Level's defaults; the approval policy stays. */
export const useResetSettings = (id: number | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      runApi((c) => c.conversations.reset({ params: { id: id ?? 0 } })),
    onSuccess: (settings) => {
      queryClient.setQueryData(["agent", id], settings);
    },
  });
};

/** Change a conversation's settings; the answer replaces the cached settings. */
export const useConfigure = (id: number | undefined) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SettingsChange) =>
      runApi((c) =>
        c.conversations.configure({ params: { id: id ?? 0 }, payload })
      ),
    onSuccess: (settings) => {
      queryClient.setQueryData(["agent", id], settings);
      return queryClient.invalidateQueries({ queryKey: LIST });
    },
  });
};

/** Every Conversation's summary, fetched now; for waiting on a status change. */
export const fetchConversations = () => runApi((c) => c.conversations.list());

export const useCreateConversation = () => {
  const queryClient = useQueryClient();
  const guard = useCapacityGuard();
  return useMutation({
    mutationFn: (payload: {
      sandbox: SandboxChoice;
      prompt: string;
      approvals?: "ask" | "auto";
      settings?: Omit<SettingsChange, "approvals">;
    }) => guard(() => runApi((c) => c.conversations.create({ payload }))),
    onSuccess: (created: ConversationSummary) => {
      queryClient.setQueryData<readonly ConversationSummary[]>(LIST, (all) => [
        ...(all ?? []),
        created,
      ]);
    },
  });
};

/** Send a prompt; a paused Conversation is resumed first, which can take Capacity. */
export const useSendMessage = (id: number) => {
  const queryClient = useQueryClient();
  const guard = useCapacityGuard();
  return useMutation({
    mutationFn: (prompt: string) => {
      // Counts on live conversations too; the resuming view only shows while the summary still says paused.
      useConversationStore.getState().beginResume(id);
      return guard(() =>
        runApi((c) =>
          c.conversations.send({ params: { id }, payload: { prompt } })
        )
      );
    },
    // The flag outlives the request itself so the view never falls back to "paused" before the list catches up.
    onSettled: async () => {
      try {
        await queryClient.invalidateQueries({ queryKey: LIST });
      } catch {
        // A failed refetch must not strand the flag.
      }
      useConversationStore.getState().endResume(id);
    },
  });
};

export const useDecideApproval = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { key: string; decision: ApprovalChoice }) =>
      runApi((c) => c.conversations.approvals({ params: { id }, payload })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST }),
  });
};

/** Each Capacity resource's limit, holders and waiters; polled for the agent's waiting Upgrade. */
export const useCapacity = () =>
  useQuery({
    queryKey: ["capacity"],
    queryFn: () => runApi((c) => c.info.capacity()),
    refetchInterval: 2000,
  });

/** Raise a Conversation's Level; with a Seat, this takes Capacity. */
export const useUpgrade = () => {
  const queryClient = useQueryClient();
  const guard = useCapacityGuard();
  return useMutation({
    mutationFn: ({ id, level }: { id: number; level: "shell" | "desktop" }) =>
      guard(() =>
        runApi((c) =>
          c.conversations.upgrade({ params: { id }, payload: { level } })
        )
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: LIST }),
  });
};

/** Withdraw the agent's Upgrade that waits for room. */
export const useCancelWait = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      runApi((c) => c.conversations.cancelWait({ params: { id } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["capacity"] }),
  });
};

export type ConversationAction =
  | "resume"
  | "pause"
  | "stop"
  | "archive"
  | "unarchive";

const resumeWith = async (guard: CapacityGuard, id: number) => {
  await guard(() => runApi((c) => c.conversations.resume({ params: { id } })));
};

/** Resume, Pause, Stop, Archive or Unarchive a Conversation. Resume can take Capacity. */
export const useConversationAction = () => {
  const queryClient = useQueryClient();
  const guard = useCapacityGuard();
  return useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: number;
      action: ConversationAction;
    }) => {
      const params = { params: { id } };
      switch (action) {
        case "resume": {
          useConversationStore.getState().beginResume(id);
          return resumeWith(guard, id);
        }
        case "pause": {
          return runApi((c) => c.conversations.pause(params));
        }
        case "stop": {
          return runApi((c) => c.conversations.stop(params));
        }
        case "archive": {
          return runApi((c) => c.conversations.archive(params));
        }
        case "unarchive": {
          return runApi((c) => c.conversations.unarchive(params));
        }
        default: {
          throw new TypeError(`Unknown action: ${action satisfies never}`);
        }
      }
    },
    // The flag outlives the request itself so the view never falls back to "paused" before the list catches up.
    onSettled: async (_data, _error, variables) => {
      try {
        await queryClient.invalidateQueries({ queryKey: LIST });
      } catch {
        // A failed refetch must not strand the flag.
      }
      if (variables.action === "resume") {
        useConversationStore.getState().endResume(variables.id);
      }
    },
  });
};

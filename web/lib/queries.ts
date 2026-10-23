"use client";

import {
  keepPreviousData,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ApprovalChoice,
  ConversationSummary,
  QuestionAnswer,
  SandboxChoice,
  SettingsChange,
  SoftwareId,
  User,
} from "effect-pi/api";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { runApi } from "./api";
import type { CapacityGuard } from "./capacity-context";
import { useCapacityGuard } from "./capacity-context";
import { seatlessOf } from "./conversation-status";
import { leaveConsole } from "./session";
import type { SignInMode } from "./sign-in";
import { useConversationStore } from "./store";
import { linkIndexOf } from "./workspace-links";
import type { WorkspaceIndex } from "./workspace-links";

const LIST = ["conversations"] as const;

export const useConversations = () =>
  useQuery({
    queryKey: LIST,
    queryFn: () => runApi((c) => c.conversations.list()),
    // Keeps status dots current; each open conversation's events are live anyway.
    refetchInterval: 2000,
  });

/** Every artifact across conversations, most recently updated first, for the /artifacts page. */
export const useArtifacts = () =>
  useQuery({
    queryKey: ["artifacts"],
    queryFn: () => runApi((c) => c.artifacts.list({ query: {} })),
    // A run can write a page between polls of the conversation list.
    refetchInterval: 2000,
  });

/**
 * One conversation's artifacts, its subagents' included, most recently updated first. Polled while it runs (a
 * running parent covers its subagents' writes), and fetched once more when a run ends, since its last page can
 * land after the last poll.
 */
export const useConversationArtifacts = (
  conversation: number | undefined,
  running: boolean
) => {
  const query = useQuery({
    queryKey: ["artifacts", conversation],
    queryFn:
      conversation === undefined
        ? skipToken
        : () => runApi((c) => c.artifacts.list({ query: { conversation } })),
    refetchInterval: running ? 2000 : false,
  });
  const { refetch } = query;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && conversation !== undefined) {
      void refetch();
    }
    wasRunning.current = running;
  }, [conversation, running, refetch]);
  return query;
};

/** Full-text over Conversation titles and messages, for the ⌘K palette; fetched while it is open. */
export const useSearch = (q: string, enabled: boolean) =>
  useQuery({
    queryKey: ["search", q],
    queryFn: () => runApi((c) => c.search.query({ query: { q } })),
    enabled,
    // A search answer is per-keystroke; a rejected one (over the 500-char cap) is not worth retrying.
    retry: false,
    // The previous list stays while the next keystroke's query loads.
    placeholderData: keepPreviousData,
  });

export const AUTH = ["auth"] as const;

/** Who the session cookie signs in, and whether the first account is still to be created. */
export interface AuthState {
  readonly user?: User;
  readonly setup: boolean;
}

export const useAuthState = () =>
  useQuery({
    queryKey: AUTH,
    queryFn: (): Promise<AuthState> => runApi((c) => c.auth.state()),
  });

/** Sign in, or create the first account (which signs it in); the session cookie comes back with the answer. */
export const useSignIn = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      mode,
      name,
      password,
    }: {
      mode: SignInMode;
      name: string;
      password: string;
    }) =>
      runApi((c) =>
        mode === "setup"
          ? c.auth.setup({ payload: { name, password } })
          : c.auth.login({ payload: { name, password } })
      ),
    onSuccess: (user) =>
      queryClient.setQueryData<AuthState>(AUTH, { user, setup: false }),
  });
};

export const useSignOut = () =>
  useMutation({
    mutationFn: () => runApi((c) => c.auth.logout()),
    onSuccess: () => leaveConsole("/login"),
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
    // MCP servers still connect once, but skills now change under us — the agent writes them and other tabs
    // save. A short staleness refetches on remount or focus, enough for the /skills page.
    staleTime: 30_000,
  });

const workspaceTreeKey = (id: number) => ["workspace-tree", id] as const;

/**
 * A conversation's tree listing, one cache entry shared by the Files tab and the links. `poll` is
 * the Files tab's 2s refresh; without it the listing stays until the run-end invalidation in
 * useWorkspaceIndex. Structural sharing keeps `data` identical across unchanged polls.
 */
export const useWorkspaceTree = (
  id: number,
  { live, poll }: { readonly live: boolean; readonly poll: boolean }
) =>
  useQuery({
    queryKey: workspaceTreeKey(id),
    queryFn: () => runApi((c) => c.files.tree({ params: { id } })),
    enabled: live,
    ...(poll
      ? { refetchInterval: 2000 }
      : { staleTime: Number.POSITIVE_INFINITY }),
  });

/**
 * The open conversation's link index (see linkIndexOf), refetched when a run ends so its new files link, and
 * `refresh` to refetch it sooner. Without a live Sandbox the query is disabled and `refresh` fetches nothing.
 */
export const useWorkspaceIndex = (
  conversation: ConversationSummary | undefined,
  running: boolean
): { readonly index: WorkspaceIndex; readonly refresh: () => void } => {
  const id = conversation?.id ?? -1;
  const sandbox = conversation?.sandbox ?? "none";
  const status = conversation?.status ?? "archived";
  const { data } = useWorkspaceTree(id, {
    live:
      conversation !== undefined &&
      sandbox !== "none" &&
      !seatlessOf({ status }),
    poll: false,
  });
  const queryClient = useQueryClient();
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: workspaceTreeKey(id) });
    }
    wasRunning.current = running;
  }, [id, queryClient, running]);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceTreeKey(id) });
  }, [id, queryClient]);
  const index = useMemo(
    () => linkIndexOf({ sandbox, status }, data?.paths),
    [sandbox, status, data]
  );
  return { index, refresh };
};

const TRUSTED_DOMAINS = ["trusted-domains"] as const;

/** The domains an artifact page may load images from, edited under Settings → Trusted domains. */
export const useTrustedDomains = () =>
  useQuery({
    queryKey: TRUSTED_DOMAINS,
    queryFn: () => runApi((c) => c.trustedDomains.list()),
  });

export const useAddDomain = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) =>
      runApi((c) => c.trustedDomains.add({ payload: { domain } })),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: TRUSTED_DOMAINS }),
  });
};

export const useRemoveDomain = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) =>
      runApi((c) => c.trustedDomains.remove({ params: { domain } })),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: TRUSTED_DOMAINS }),
  });
};

/** One skill's folder — text contents plus the binary files' names — for the /skills editor. */
export const useSkill = (name: string | undefined) =>
  useQuery({
    queryKey: ["skill", name],
    queryFn: () =>
      runApi((c) => c.skills.get({ params: { name: name ?? "" } })),
    enabled: name !== undefined,
  });

// A skill write changes the catalog; refetch it even though it never goes stale on its own.
const invalidateSkill = (
  queryClient: ReturnType<typeof useQueryClient>,
  name: string
) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: ["capabilities"],
      refetchType: "all",
    }),
    queryClient.invalidateQueries({ queryKey: ["skill", name] }),
  ]);

/** Create a skill or replace one wholesale: `files` is every file its folder will hold. */
export const useSaveSkill = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      files,
    }: {
      name: string;
      files: Record<string, string>;
    }) =>
      runApi((c) => c.skills.save({ params: { name }, payload: { files } })),
    onSuccess: (_saved, { name }) => invalidateSkill(queryClient, name),
  });
};

/** Delete a skill's org copy — gone, or reverted to the builtin it shadowed. */
export const useDeleteSkill = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      runApi((c) => c.skills.remove({ params: { name } })),
    onSuccess: (_result, name) => invalidateSkill(queryClient, name),
  });
};

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

const updateSummary =
  (queryClient: ReturnType<typeof useQueryClient>) =>
  (updated: ConversationSummary) => {
    queryClient.setQueryData<readonly ConversationSummary[]>(LIST, (all) =>
      all?.map((each) => (each.id === updated.id ? updated : each))
    );
    return queryClient.invalidateQueries({ queryKey: LIST });
  };

/** The person's rename: automation never touches the title again. */
export const useRenameConversation = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ title }: { title: string }) =>
      runApi((c) =>
        c.conversations.rename({ params: { id }, payload: { title } })
      ),
    onSuccess: updateSummary(queryClient),
  });
};

/** Ask the model for a fresh title; fails when no real model is configured. */
export const useGenerateTitle = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      runApi((c) => c.conversations.generateTitle({ params: { id } })),
    onSuccess: updateSummary(queryClient),
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
      software?: readonly SoftwareId[];
      prompt: string;
      /** Ids of staged uploads; the create claims them. */
      attachments?: readonly string[];
      /** Dedupes the first message's submission, which carries it. */
      requestId?: string;
      approvals?: "ask" | "auto";
      settings?: Omit<SettingsChange, "approvals">;
    }) => guard(() => runApi((c) => c.conversations.create({ payload }))),
    onSuccess: (created) => {
      queryClient.setQueryData<readonly ConversationSummary[]>(LIST, (all) => [
        ...(all ?? []).filter((each) => each.id !== created.id),
        created,
      ]);
    },
  });
};

/** Send a prompt and the conversation's uploads; a paused Conversation is resumed first, which can take Capacity. */
export const useSendMessage = (id: number) => {
  const queryClient = useQueryClient();
  const guard = useCapacityGuard();
  return useMutation({
    mutationFn: (payload: {
      prompt: string;
      attachments?: readonly string[];
      /** Dedupes the message's submission, which carries it. */
      requestId?: string;
    }) => {
      // Counts on live conversations too; the resuming view only shows while the summary still says paused.
      useConversationStore.getState().beginResume(id);
      return guard(() =>
        runApi((c) => c.conversations.send({ params: { id }, payload }))
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

/** Take a queued message back before a run picks it up; the outcome says whether it was still queued. */
export const useWithdrawMessage = (id: number | undefined) =>
  useMutation({
    mutationFn: (submission: number) =>
      id === undefined
        ? Promise.reject(new Error("The conversation is not ready yet."))
        : runApi((c) =>
            c.conversations.withdraw({ params: { id, submission } })
          ),
  });

export const useDecideApproval = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { key: string; decision: ApprovalChoice }) =>
      runApi((c) => c.conversations.approvals({ params: { id }, payload })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST }),
  });
};

/** Answer an `ask_user` call; without `answers` its questions are skipped. */
export const useAnswerQuestions = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { key: string; answers?: QuestionAnswer[] }) =>
      runApi((c) => c.conversations.answers({ params: { id }, payload })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST }),
  });
};

/** Thumbs up or down on an assistant entry, scored on its run's trace; there is no feedback state to read back. */
export const useFeedback = (id: number) =>
  useMutation({
    mutationFn: (payload: { entry: number; value: 0 | 1; comment?: string }) =>
      runApi((c) => c.conversations.feedback({ params: { id }, payload })),
    onError: (error) => toast.error(error.message, { duration: Infinity }),
  });

/** Report an assistant entry, scored on its run's trace; `comment` is required. */
export const useReport = (id: number) =>
  useMutation({
    mutationFn: (payload: { entry: number; comment: string }) =>
      runApi((c) => c.conversations.report({ params: { id }, payload })),
    onError: (error) => toast.error(error.message, { duration: Infinity }),
  });

/** Each Capacity resource's limit, holders and waiters; polled for the agent's waiting Upgrade. */
export const useCapacity = () =>
  useQuery({
    queryKey: ["capacity"],
    queryFn: () => runApi((c) => c.info.capacity()),
    refetchInterval: 2000,
  });

/** Raise a Conversation's Level, add Software, or both; with a Seat, this takes Capacity. */
export const useUpgrade = () => {
  const queryClient = useQueryClient();
  const guard = useCapacityGuard();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: number;
      level?: "shell" | "desktop";
      software?: readonly SoftwareId[];
    }) =>
      guard(() =>
        runApi((c) => c.conversations.upgrade({ params: { id }, payload }))
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

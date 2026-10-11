"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSummary, SandboxChoice } from "effect-pi/api";

import { runApi } from "./api";

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

export const useCreateConversation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      sandbox: SandboxChoice;
      prompt: string;
      approvals?: "ask" | "auto";
    }) => runApi((c) => c.conversations.create({ payload })),
    onSuccess: (created: ConversationSummary) => {
      queryClient.setQueryData<readonly ConversationSummary[]>(LIST, (all) => [
        ...(all ?? []),
        created,
      ]);
    },
  });
};

export const useSendMessage = (id: number) =>
  useMutation({
    mutationFn: (prompt: string) =>
      runApi((c) =>
        c.conversations.send({ params: { id }, payload: { prompt } })
      ),
  });

export const useDecideApproval = (id: number) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      key: string;
      decision: "approve" | "deny" | "always";
    }) => runApi((c) => c.conversations.approvals({ params: { id }, payload })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST }),
  });
};

export const useEndConversation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      runApi((c) => c.conversations.end({ params: { id } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: LIST }),
  });
};

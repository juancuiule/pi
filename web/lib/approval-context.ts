"use client";

import { createContext, useContext } from "react";

import type { useAnswerQuestions, useDecideApproval } from "./queries";

/** The approval-decision mutation bound to the open (root) conversation. Nested subagent calls use the
 * same context because keys carry their own conversation id. */
export const ApprovalContext = createContext<
  ReturnType<typeof useDecideApproval> | undefined
>(undefined);

export const useApproval = () => useContext(ApprovalContext);

/** The `ask_user` answers mutation bound to the open conversation. */
export const AnswersContext = createContext<
  ReturnType<typeof useAnswerQuestions> | undefined
>(undefined);

export const useAnswers = () => useContext(AnswersContext);

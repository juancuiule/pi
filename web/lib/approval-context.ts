"use client";

import { createContext, useContext } from "react";

import type { useDecideApproval } from "./queries";

/** The approval-decision mutation bound to the open conversation. */
export const ApprovalContext = createContext<
  ReturnType<typeof useDecideApproval> | undefined
>(undefined);

export const useApproval = () => useContext(ApprovalContext);

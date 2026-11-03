"use client";

import { titleWith } from "@/lib/conversation-status";
import { useConsoleSummary } from "@/lib/use-console-summary";

/** A console page's `<title>`, led by `(n)` while n conversations wait for the person or failed. */
export const PageTitle = ({ children }: { children: string }) => (
  <title>{titleWith(children, useConsoleSummary())}</title>
);

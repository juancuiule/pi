"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import type { ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";

export const Providers = ({ children }: { children: ReactNode }) => {
  // oxlint-disable-next-line react/hook-use-state -- the client is created once and never replaced
  const [queryClient] = useState(() => new QueryClient());
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
};

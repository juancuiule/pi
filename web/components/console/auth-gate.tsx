"use client";

// The console renders only for a signed-in User. Without one, and whenever a call later finds the session gone, it
// leaves for /login: the server's caches and the conversation store are dropped first, so the next person to sign
// in never sees this one's conversations.
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { apiError } from "@/lib/api";
import { AUTH, useAuthState } from "@/lib/queries";
import type { AuthState } from "@/lib/queries";
import { onLeaveConsole, sessionLost, signedIn } from "@/lib/session";
import { useConversationStore } from "@/lib/store";

export const AuthGate = ({ children }: { children: ReactNode }) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, error, refetch } = useAuthState();
  const user = data?.user;

  useEffect(
    () =>
      onLeaveConsole((to) => {
        // Signed out first: the gate stops rendering the console, so its queries are not fetched again.
        queryClient.setQueryData<AuthState>(AUTH, (state) => ({
          setup: state?.setup ?? false,
        }));
        queryClient.removeQueries({
          predicate: (query) => query.queryKey[0] !== AUTH[0],
        });
        useConversationStore.setState(
          useConversationStore.getInitialState(),
          true
        );
        router.replace(to);
      }),
    [queryClient, router]
  );

  useEffect(() => {
    if (data === undefined) {
      return;
    }
    if (user === undefined) {
      sessionLost();
    } else {
      signedIn();
    }
  }, [data, user]);

  if (error !== null && data === undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <p className="text-muted-foreground text-sm" role="alert">
          Couldn&apos;t reach the server: {apiError(error)}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  return user === undefined ? null : children;
};

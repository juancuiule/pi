"use client";

import type { ExposedPort } from "effect-pi/api";
import { ExternalLink, Globe, X } from "lucide-react";
import { toast } from "sonner";

import { useClosePort } from "@/lib/queries";

/**
 * The ports the agent exposed on the Conversation's Sandbox, as chips in the header: the link opens the
 * URL in a new tab, the × closes it for good (the agent can always expose it again).
 */
export const ExposedPorts = ({
  id,
  ports,
}: {
  id: number;
  ports: readonly ExposedPort[];
}) => {
  const close = useClosePort(id);
  return (
    <>
      {ports.map((exposed) => (
        <span
          key={exposed.port}
          className="border-border bg-muted/50 inline-flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5 font-mono"
        >
          <Globe aria-hidden className="size-3 shrink-0" />
          <a
            href={exposed.url}
            target="_blank"
            rel="noreferrer"
            title={`${exposed.url} → sandbox port ${exposed.port}`}
            className="hover:text-foreground inline-flex items-center gap-1 truncate"
          >
            {exposed.label ?? `port ${exposed.port}`}
            <ExternalLink aria-hidden className="size-3 shrink-0" />
          </a>
          <button
            type="button"
            aria-label={`Close ${exposed.label ?? `port ${exposed.port}`}`}
            disabled={close.isPending}
            onClick={() =>
              close.mutate(
                { port: exposed.port },
                { onError: (error) => toast.error(error.message) }
              )
            }
            className="hover:bg-muted hover:text-foreground rounded-sm p-0.5"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
    </>
  );
};

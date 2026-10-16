"use client";

import { Button } from "@/components/ui/button";
import type { Holder } from "@/lib/capacity";

/** A Conversation holding a Capacity resource, with the pause actions the dialog and the capacity page share. */
export const HolderRow = ({
  holder,
  disabled,
  onPause,
}: {
  holder: Holder;
  disabled: boolean;
  onPause: (stopFirst: boolean) => void;
}) => (
  <li className="flex items-center gap-2 rounded-md border px-3 py-2">
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm font-medium" title={holder.title}>
        {holder.title}
      </span>
      <span className="text-muted-foreground text-xs">
        {holder.running ? "Working" : "Idle"}
        {holder.pausing ? " · Pausing after this run" : ""}
      </span>
    </span>
    {holder.running ? (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || holder.pausing}
          onClick={() => onPause(false)}
        >
          After this run
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onPause(true)}
        >
          Stop and pause
        </Button>
      </>
    ) : (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onPause(false)}
      >
        Pause
      </Button>
    )}
  </li>
);

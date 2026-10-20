"use client";

// The Software checklist of New conversation, and the Upgrade's "Add software" dialog.
import type { ConversationSummary, SoftwareId } from "effect-pi/api";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useCapabilities, useUpgrade } from "@/lib/queries";
import { pick, softwareChoices, softwareToAdd } from "@/lib/software";
import type { SoftwareChoice } from "@/lib/software";

export const SOFTWARE_BUILD_HINT =
  "The first conversation with a new combination builds an image, which can take a few minutes; later ones reuse it.";

export const SoftwareChecklist = ({
  choices,
  onPick,
  error,
}: {
  choices: readonly SoftwareChoice[];
  onPick: (id: SoftwareId, picked: boolean) => void;
  error?: string | undefined;
}) => {
  const prefix = useId();
  const errorId = `${prefix}-error`;
  return (
    <>
      <ul className="flex flex-col gap-2.5">
        {choices.map(({ entry, checked, disabled, note }) => (
          <li key={entry.id} className="flex items-start gap-3">
            <Checkbox
              id={`${prefix}-${entry.id}`}
              checked={checked}
              disabled={disabled}
              aria-invalid={disabled || error === undefined ? undefined : true}
              aria-describedby={
                disabled || error === undefined ? undefined : errorId
              }
              onCheckedChange={(on) => onPick(entry.id, on)}
              className="mt-0.5"
            />
            <label
              htmlFor={`${prefix}-${entry.id}`}
              className={
                disabled
                  ? "flex cursor-not-allowed flex-col gap-0.5"
                  : "flex cursor-pointer flex-col gap-0.5"
              }
            >
              <span className="text-sm font-medium">
                {entry.label}
                {note === undefined ? null : (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    · {note}
                  </span>
                )}
              </span>
              <span className="text-muted-foreground text-xs">
                {entry.description}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </>
  );
};

/** Adds Software to a Conversation with an Upgrade at its Level. */
export const AddSoftwareDialog = ({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: ConversationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { data: capabilities } = useCapabilities();
  const upgrade = useUpgrade();
  const [picked, setPicked] = useState<SoftwareId[]>([]);
  const [attempted, setAttempted] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const catalog = capabilities?.software ?? [];
  const toAdd = softwareToAdd(
    catalog,
    conversation.sandbox,
    conversation.software,
    picked
  );
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPicked([]);
          setAttempted(false);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add software</AlertDialogTitle>
          <AlertDialogDescription>
            The agent gets a new sandbox with it; its files stay.{" "}
            {SOFTWARE_BUILD_HINT}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div ref={list} className="min-h-0 overflow-y-auto">
          <SoftwareChecklist
            choices={softwareChoices(
              catalog,
              conversation.sandbox,
              conversation.software,
              picked
            )}
            onPick={(id, on) => setPicked((current) => pick(current, id, on))}
            error={
              attempted && toAdd.length === 0
                ? "Pick at least one to add."
                : undefined
            }
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={upgrade.isPending}
            onClick={() => {
              if (toAdd.length === 0) {
                setAttempted(true);
                list.current
                  ?.querySelector<HTMLElement>("button:not(:disabled)")
                  ?.focus();
                return;
              }
              onOpenChange(false);
              const labels = catalog
                .filter((entry) => toAdd.includes(entry.id))
                .map((entry) => entry.label)
                .join(", ");
              const progress = toast.loading(`Adding ${labels}…`);
              upgrade.mutate(
                { id: conversation.id, software: toAdd },
                {
                  onSuccess: () =>
                    toast.success(`Added ${labels}`, { id: progress }),
                  onError: (error) =>
                    toast.error(error.message, {
                      id: progress,
                      duration: Infinity,
                    }),
                }
              );
            }}
          >
            Add
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

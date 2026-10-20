"use client";

// The Software checklist of New conversation, and the Upgrade's "Add software" dialog.
import type { ConversationSummary, SoftwareId } from "effect-pi/api";
import { useId, useState } from "react";
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
}: {
  choices: readonly SoftwareChoice[];
  onPick: (id: SoftwareId, picked: boolean) => void;
}) => {
  const prefix = useId();
  return (
    <ul className="flex flex-col gap-2.5">
      {choices.map(({ entry, checked, disabled, note }) => (
        <li key={entry.id} className="flex items-start gap-3">
          <Checkbox
            id={`${prefix}-${entry.id}`}
            checked={checked}
            disabled={disabled}
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
        <div className="min-h-0 overflow-y-auto">
          <SoftwareChecklist
            choices={softwareChoices(
              catalog,
              conversation.sandbox,
              conversation.software,
              picked
            )}
            onPick={(id, on) => setPicked((current) => pick(current, id, on))}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={toAdd.length === 0 || upgrade.isPending}
            onClick={() => {
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
                    toast.error(error.message, { id: progress }),
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

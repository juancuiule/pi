// The Software checklist, for New conversation and the Upgrade dialog: which entries a Level allows, which are
// installed already, and what to send.
import type { Capabilities, SandboxChoice, SoftwareId } from "effect-pi/api";

import { RANK } from "./capacity";

export type SoftwareEntry = Capabilities["software"][number];

export interface SoftwareChoice {
  readonly entry: SoftwareEntry;
  readonly checked: boolean;
  readonly disabled: boolean;
  /** Why it cannot be changed. */
  readonly note?: "Installed" | "Desktop only" | "Needs a shell";
}

/** The checklist for a Workspace at `level` with `installed`, and the entries picked in the form. */
export const softwareChoices = (
  entries: readonly SoftwareEntry[],
  level: SandboxChoice,
  installed: readonly SoftwareId[],
  picked: readonly SoftwareId[]
): SoftwareChoice[] =>
  entries.map((entry) => {
    if (installed.includes(entry.id)) {
      return { entry, checked: true, disabled: true, note: "Installed" };
    }
    if (RANK[entry.level] > RANK[level]) {
      return {
        entry,
        checked: false,
        disabled: true,
        note: entry.level === "desktop" ? "Desktop only" : "Needs a shell",
      };
    }
    return { entry, checked: picked.includes(entry.id), disabled: false };
  });

/** Whether an Upgrade could add anything at `level`. */
export const canAddSoftware = (
  entries: readonly SoftwareEntry[],
  level: SandboxChoice,
  installed: readonly SoftwareId[]
): boolean =>
  softwareChoices(entries, level, installed, []).some(
    (choice) => !choice.disabled
  );

/** `picked` with `id` added or removed. */
export const pick = (
  picked: readonly SoftwareId[],
  id: SoftwareId,
  on: boolean
): SoftwareId[] =>
  on
    ? [...picked.filter((each) => each !== id), id]
    : picked.filter((each) => each !== id);

/** What to send: the picked entries the Level allows that are not installed already. A pick the Level drops stays picked in the form. */
export const softwareToAdd = (
  entries: readonly SoftwareEntry[],
  level: SandboxChoice,
  installed: readonly SoftwareId[],
  picked: readonly SoftwareId[]
): SoftwareId[] =>
  softwareChoices(entries, level, installed, picked)
    .filter((choice) => choice.checked && !choice.disabled)
    .map((choice) => choice.entry.id);

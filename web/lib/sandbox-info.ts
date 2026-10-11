import type { SandboxChoice } from "effect-pi/api";

/** Human label per sandbox choice; shared by badges, the sidebar and exports. */
export const SANDBOX_LABEL: Record<SandboxChoice, string> = {
  none: "Chat",
  shell: "Shell",
  desktop: "Desktop",
};

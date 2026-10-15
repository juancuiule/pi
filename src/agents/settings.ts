// A conversation's settings: which extensions, tools and skills the agent has, and its approval policy. Pure: Agents
// reads the state from the conversation's documents, and applies what `applyChange` returns.
import type { ApprovalPolicy } from "../approvals.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";

export interface InstalledTool {
  readonly name: string;
  readonly description: string;
  /** Waits for a person's decision under the `ask` approval policy. */
  readonly approval: boolean;
}

/** An installed extension, as settings see it. */
export interface InstalledExtension {
  readonly name: string;
  readonly tools: readonly InstalledTool[];
  /** The Levels at which it can be on; at other Levels it needs an Upgrade first. */
  readonly levels: readonly SandboxChoice[];
  /** Always on, whatever the person asks (tracing). */
  readonly locked: boolean;
}

export interface CatalogSkill {
  readonly name: string;
  readonly description: string;
}

/** What a conversation has now. */
export interface SettingsState {
  readonly level: SandboxChoice;
  readonly approvals: ApprovalPolicy;
  /** Names of the enabled extensions. */
  readonly extensions: readonly string[];
  /** Names of tools turned off; they stay off whether or not their extension is on. */
  readonly disabledTools: readonly string[];
  /** Names of the enabled skills. */
  readonly skills: readonly string[];
}

/** Each entry turns one extension, tool or skill on (`true`) or off (`false`). */
export interface SettingsChange {
  readonly approvals?: ApprovalPolicy | undefined;
  readonly extensions?: Readonly<Record<string, boolean>> | undefined;
  readonly tools?: Readonly<Record<string, boolean>> | undefined;
  readonly skills?: Readonly<Record<string, boolean>> | undefined;
}

export interface ConversationSettings {
  readonly level: SandboxChoice;
  readonly approvals: ApprovalPolicy;
  readonly extensions: readonly {
    readonly name: string;
    readonly enabled: boolean;
    /** False when the Level does not allow it; it can then only be off. */
    readonly available: boolean;
    readonly locked: boolean;
    readonly tools: readonly (InstalledTool & { readonly enabled: boolean })[];
  }[];
  readonly skills: readonly (CatalogSkill & { readonly enabled: boolean })[];
}

/** A change that cannot be applied: an unknown name, a locked extension, or one the Level does not allow. */
export interface SettingsProblem {
  readonly name: string;
  readonly reason: string;
}

export const describeSettings = (
  installed: readonly InstalledExtension[],
  catalog: readonly CatalogSkill[],
  state: SettingsState
): ConversationSettings => {
  const enabled = new Set(state.extensions);
  const disabledTools = new Set(state.disabledTools);
  const enabledSkills = new Set(state.skills);
  return {
    level: state.level,
    approvals: state.approvals,
    extensions: installed.map((extension) => ({
      name: extension.name,
      enabled: enabled.has(extension.name),
      available: extension.levels.includes(state.level),
      locked: extension.locked,
      tools: extension.tools.map((tool) => ({
        ...tool,
        enabled: !disabledTools.has(tool.name),
      })),
    })),
    skills: catalog.map((skill) => ({
      ...skill,
      enabled: enabledSkills.has(skill.name),
    })),
  };
};

const NEEDS: Record<SandboxChoice, string> = {
  none: "a chat",
  shell: "a shell; upgrade first",
  desktop: "a desktop; upgrade first",
};

const toggle = (names: Set<string>, name: string, on: boolean) => {
  if (on) {
    names.add(name);
  } else {
    names.delete(name);
  }
};

const toggleExtensions = (
  installed: readonly InstalledExtension[],
  level: SandboxChoice,
  extensions: Set<string>,
  change: Readonly<Record<string, boolean>>
): SettingsProblem | undefined => {
  for (const [name, on] of Object.entries(change)) {
    const extension = installed.find((each) => each.name === name);
    if (extension === undefined) {
      return { name, reason: "no such extension" };
    }
    if (extension.locked && !on) {
      return { name, reason: "always on" };
    }
    if (on && !extension.levels.includes(level)) {
      return {
        name,
        reason: `needs ${NEEDS[extension.levels[0] ?? "desktop"]}`,
      };
    }
    toggle(extensions, name, on);
  }
  return undefined;
};

const toggleKnown = (
  known: ReadonlySet<string>,
  names: Set<string>,
  change: Readonly<Record<string, boolean>>,
  kind: string
): SettingsProblem | undefined => {
  for (const [name, on] of Object.entries(change)) {
    if (!known.has(name)) {
      return { name, reason: `no such ${kind}` };
    }
    toggle(names, name, on);
  }
  return undefined;
};

/** A locked extension's tools stay on with it. */
const lockedTool = (
  installed: readonly InstalledExtension[],
  change: Readonly<Record<string, boolean>>
): SettingsProblem | undefined => {
  const name = Object.keys(change).find(
    (tool) =>
      change[tool] === false &&
      installed.some(
        (each) => each.locked && each.tools.some((info) => info.name === tool)
      )
  );
  return name === undefined ? undefined : { name, reason: "always on" };
};

/** The state after `change`, or the first problem with it. */
export const applyChange = (
  installed: readonly InstalledExtension[],
  catalog: readonly CatalogSkill[],
  state: SettingsState,
  change: SettingsChange
): SettingsState | SettingsProblem => {
  const extensions = new Set(state.extensions);
  // Tools are tracked as the ones turned off, so a tool toggled on leaves that set.
  const enabledTools = new Set(
    installed
      .flatMap((each) => each.tools.map((tool) => tool.name))
      .filter((name) => !state.disabledTools.includes(name))
  );
  const allTools = new Set(
    installed.flatMap((each) => each.tools.map((tool) => tool.name))
  );
  const skills = new Set(state.skills);
  const problem =
    toggleExtensions(
      installed,
      state.level,
      extensions,
      change.extensions ?? {}
    ) ??
    lockedTool(installed, change.tools ?? {}) ??
    toggleKnown(allTools, enabledTools, change.tools ?? {}, "tool") ??
    toggleKnown(
      new Set(catalog.map((skill) => skill.name)),
      skills,
      change.skills ?? {},
      "skill"
    );
  if (problem !== undefined) {
    return problem;
  }
  // The skills extension (the skill tool and the skills list) goes with the last skill, and comes back with a
  // skill turned on, unless this change turns it off itself; a change that turns no skill on leaves it as it is.
  const turnedOn = [...skills].some((name) => !state.skills.includes(name));
  if (skills.size === 0) {
    extensions.delete("skills");
  } else if (turnedOn && change.extensions?.skills !== false) {
    extensions.add("skills");
  }
  return {
    level: state.level,
    approvals: change.approvals ?? state.approvals,
    // Installed order, which is the order conversations select them in.
    extensions: installed
      .map((each) => each.name)
      .filter((name) => extensions.has(name)),
    disabledTools: [...allTools].filter((name) => !enabledTools.has(name)),
    skills: catalog
      .map((skill) => skill.name)
      .filter((name) => skills.has(name)),
  };
};

export const isProblem = (
  result: SettingsState | SettingsProblem
): result is SettingsProblem => "reason" in result;

/** One thing that changed in a conversation's settings, as the conversation records it. */
// A type, not an interface: it is stored in an entry's data, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type SettingsEvent =
  | { type: "approvals"; policy: ApprovalPolicy }
  | { type: "level"; from: SandboxChoice; to: SandboxChoice }
  // `provider/modelId`; `from` is "" for a conversation that had no model.
  | { type: "model"; from: string; to: string }
  | { type: "extension" | "tool" | "skill"; name: string; on: boolean };

/** What a conversation records when its settings change: who changed them and how. */
// oxlint-disable-next-line typescript/consistent-type-definitions
export type SettingsRecord = {
  /** `server` when the server changed them itself, as when a conversation's model is no longer available. */
  by: "person" | "agent" | "server";
  /** True for a reset to the Level's defaults. */
  reset?: boolean;
  changes: SettingsEvent[];
};

/** The entry kind of a `SettingsRecord`; it carries no model messages, so the model never sees it. */
export const SETTINGS_ENTRY = "app.settings";

const toggled = (
  type: "extension" | "tool" | "skill",
  before: readonly string[],
  after: readonly string[],
  // For tools the lists hold the ones turned off.
  off = false
): SettingsEvent[] => [
  ...after
    .filter((name) => !before.includes(name))
    .map((name) => ({ type, name, on: !off })),
  ...before
    .filter((name) => !after.includes(name))
    .map((name) => ({ type, name, on: off })),
];

/** What differs between two states, in the order a person reads it. */
export const changesBetween = (
  before: SettingsState,
  after: SettingsState
): SettingsEvent[] => [
  ...(before.level === after.level
    ? []
    : [{ type: "level" as const, from: before.level, to: after.level }]),
  ...(before.approvals === after.approvals
    ? []
    : [{ type: "approvals" as const, policy: after.approvals }]),
  ...toggled("extension", before.extensions, after.extensions),
  ...toggled("tool", before.disabledTools, after.disabledTools, true),
  ...toggled("skill", before.skills, after.skills),
];

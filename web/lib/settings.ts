// Pure helpers for a conversation's settings in the console: the defaults a new conversation gets at a Level, and
// the switches a person flipped before creating it.
import type {
  Capabilities,
  ConversationAgent,
  SandboxChoice,
  SoftwareId,
} from "effect-pi/api";

/** The settings a panel shows: a conversation's, or a new one's. */
export type Settings = Pick<ConversationAgent, "extensions" | "skills">;

/** Switches a person flipped: each entry turns one extension, tool or skill on or off. */
export interface Overrides {
  readonly extensions: Readonly<Record<string, boolean>>;
  readonly tools: Readonly<Record<string, boolean>>;
  readonly skills: Readonly<Record<string, boolean>>;
}

export const NO_OVERRIDES: Overrides = {
  extensions: {},
  tools: {},
  skills: {},
};

/**
 * What a new conversation at `level` with `software` gets, with `overrides` applied; the server applies the same
 * rules.
 */
export const newConversationSettings = (
  capabilities: Capabilities,
  level: SandboxChoice,
  software: readonly SoftwareId[],
  overrides: Overrides
): Settings => ({
  extensions: capabilities.extensions.map((extension) => {
    const available =
      extension.levels.includes(level) &&
      (extension.software === undefined ||
        software.includes(extension.software));
    // The skills extension carries the write tools too, so it is on even with no skills.
    const byDefault = available;
    return {
      name: extension.name,
      available,
      locked: extension.locked,
      ...(extension.software === undefined
        ? {}
        : { software: extension.software }),
      enabled: available && (overrides.extensions[extension.name] ?? byDefault),
      tools: extension.tools.map((tool) => ({
        ...tool,
        enabled: overrides.tools[tool.name] ?? true,
      })),
    };
  }),
  skills: capabilities.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    enabled: overrides.skills[skill.name] ?? true,
  })),
});

/** True when no switch was flipped, so the create needs no settings. */
export const isEmpty = (overrides: Overrides): boolean =>
  Object.keys(overrides.extensions).length === 0 &&
  Object.keys(overrides.tools).length === 0 &&
  Object.keys(overrides.skills).length === 0;

/** `overrides` with one more switch flipped. */
export const flip = (
  overrides: Overrides,
  kind: keyof Overrides,
  name: string,
  on: boolean
): Overrides => ({
  ...overrides,
  [kind]: { ...overrides[kind], [name]: on },
});

/**
 * The create payload's settings: the flipped switches, less extension switches the chosen Level does not allow
 * (flipped at another Level), which the server would refuse; `undefined` when nothing is left.
 */
export const settingsPayload = (
  overrides: Overrides,
  settings: Settings
): Overrides | undefined => {
  const extensions = Object.fromEntries(
    Object.entries(overrides.extensions).filter(
      ([name]) =>
        settings.extensions.find((each) => each.name === name)?.available ??
        false
    )
  );
  const payload = { ...overrides, extensions };
  return isEmpty(payload) ? undefined : payload;
};

// The line the transcript shows for a settings record (an `app.settings` entry): who changed what.
const LEVEL = {
  none: "a chat",
  shell: "a shell",
  desktop: "a desktop",
} as const;

interface Change {
  readonly type: string;
  readonly name?: string;
  readonly on?: boolean;
  readonly policy?: string;
  readonly to?: keyof typeof LEVEL;
}

const describe = (change: Change): string => {
  switch (change.type) {
    case "approvals": {
      return change.policy === "ask"
        ? "approvals asked for"
        : "approvals off (auto)";
    }
    case "level": {
      return `upgraded to ${LEVEL[change.to ?? "none"]}`;
    }
    default: {
      return `${change.name ?? "?"} ${change.on === true ? "on" : "off"}`;
    }
  }
};

/** "You changed settings: bash off, calculator on"; `undefined` for data that is not a settings record. */
export const settingsNote = (data: unknown): string | undefined => {
  if (typeof data !== "object" || data === null || !("changes" in data)) {
    return undefined;
  }
  const record = data as {
    readonly by?: string;
    readonly reset?: boolean;
    readonly changes: readonly Change[];
  };
  const who = record.by === "agent" ? "The agent" : "You";
  if (record.reset === true) {
    return `${who} reset the settings to their defaults`;
  }
  const [only] = record.changes;
  if (record.changes.length === 1 && only?.type === "level") {
    return `${who} ${describe(only)}`;
  }
  return `${who} changed settings: ${record.changes.map(describe).join(", ")}`;
};

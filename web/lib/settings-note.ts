// The line the transcript shows for a settings record (an `app.settings` entry): who changed what.
const LEVEL: Readonly<Record<string, string>> = {
  none: "a chat",
  shell: "a shell",
  desktop: "a desktop",
};

interface Change {
  readonly type: string;
  readonly name?: string;
  readonly on?: boolean;
  readonly policy?: string;
  /** A Level, or `provider/modelId` for a model change. */
  readonly from?: string;
  readonly to?: string;
}

const describe = (change: Change): string => {
  switch (change.type) {
    case "approvals": {
      return change.policy === "ask"
        ? "approvals asked for"
        : "approvals off (auto)";
    }
    case "level": {
      const to = change.to ?? "none";
      return `upgraded to ${LEVEL[to] ?? to}`;
    }
    case "model": {
      return `model ${change.to ?? "?"}`;
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
  const [only] = record.changes;
  // The server moves a conversation off a model it does not have.
  if (record.changes.length === 1 && only?.type === "model") {
    const from =
      only.from === undefined || only.from === "" ? "" : `${only.from} `;
    return `Switched to ${only.to ?? "?"}: the model ${from}is not available`;
  }
  const who = record.by === "agent" ? "The agent" : "You";
  if (record.reset === true) {
    return `${who} reset the settings to their defaults`;
  }
  if (record.changes.length === 1 && only?.type === "level") {
    return `${who} ${describe(only)}`;
  }
  return `${who} changed settings: ${record.changes.map(describe).join(", ")}`;
};

/** The child conversation id a `subagent` tool reports in its `details`. */
export const subagentIdOf = (details?: unknown): number | undefined => {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const id = (details as { conversationId?: unknown }).conversationId;
  return typeof id === "number" && Number.isInteger(id) ? id : undefined;
};

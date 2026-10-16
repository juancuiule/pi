/** The `?c` search param's conversation id; `undefined` unless it is an integer. */
export const parseConversationId = (
  value: string | null
): number | undefined => {
  const id = value === null ? Number.NaN : Number(value);
  return Number.isInteger(id) ? id : undefined;
};

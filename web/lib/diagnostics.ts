// Tool diagnostics the harness attaches to a result entry's `data.diagnostics` — model-visible remarks such as a
// failed exit code or truncation. appendToolResult also appends them as a `<harness>` text block on the result so the
// stored message is exactly what the model saw; the console renders the structured list instead of that markup.
import type { Message } from "effect-pi/api";

export interface ToolDiagnostic {
  readonly severity: "error" | "warn" | "info";
  readonly code: string | undefined;
  readonly message: string;
}

/** The `diagnostics` list on a `pi.tool-result` entry's data, defensively read. */
export const diagnosticsOf = (data: unknown): readonly ToolDiagnostic[] => {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const { diagnostics } = data as Record<string, unknown>;
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  return diagnostics.flatMap((diagnostic) => {
    if (typeof diagnostic !== "object" || diagnostic === null) {
      return [];
    }
    const { severity, code, message } = diagnostic as Record<string, unknown>;
    return typeof message === "string"
      ? [
          {
            severity:
              severity === "warn" || severity === "info" ? severity : "error",
            code: typeof code === "string" ? code : undefined,
            message,
          },
        ]
      : [];
  });
};

type ResultContent = Extract<
  Message,
  { role: "toolResult" }
>["content"][number];

/**
 * The result's content minus the trailing `<harness>` diagnostics block. The harness appends that block exactly when
 * `data.diagnostics` is non-empty, so a tool's own text that happens to start with the tag survives.
 */
export const visibleResultContent = (
  content: readonly ResultContent[],
  diagnostics: readonly ToolDiagnostic[]
): readonly ResultContent[] => {
  const last = content.at(-1);
  return diagnostics.length > 0 &&
    last?.type === "text" &&
    last.text.startsWith("<harness>")
    ? content.slice(0, -1)
    : content;
};

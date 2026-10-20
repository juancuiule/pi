// The repeat guard: an always-on extension whose task hooks count how many times a run emits the
// same tool call and gets the same result back. Once a call has returned byte-identical output
// BLOCK_AT times, further emissions fail back to the model without executing; at TERMINATE_AT
// emissions the run ends — every result of that round votes `terminate` (pi-durable's terminate
// applies only when every call of the round asks for it, which is why the flag is a signature,
// not a call id). Issue #64's transcript was two byte-identical commands alternating ~10 times
// each until the provider errored; counting identical results rather than consecutive calls is
// what catches an alternation, and requiring identical results is what leaves re-runs whose
// output changed (a fixing test loop) alone.
import type { ToolCall } from "@earendil-works/pi-ai";
import {
  defineExtension,
  hook,
  LiveDoc,
  ToolTask,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Extension,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";

/** Executions of one call that may return the same result before repeats start failing. */
const BLOCK_AT = 3;
/** Emissions of one stuck call that flag it; the next result votes to end the run. */
const TERMINATE_AT = 6;
/** The diagnostic code `afterTool` stamps on the results that end a repeating run. */
export const REPEAT_GUARD_CODE = "repeat_guard";

interface Streak {
  resultKey: string;
  repeats: number;
}

interface Guard {
  /** `String(live.run.inputs[0])`: the run this state counts; changes reset it. */
  runKey?: string | undefined;
  /** Per signature, the last result and how many times in a row the call produced it. */
  readonly calls: Map<string, Streak>;
  /** The signature whose repeats crossed TERMINATE_AT; while set, every result votes to end. */
  terminating?: string | undefined;
}

/** `value` with every object's keys sorted, so equivalent arguments spell the same JSON. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => [key, canonical(field)])
    );
  }
  return value;
};

/** `call`'s name plus its arguments serialized with sorted keys — one call signs one string. */
const signature = (call: ToolCall): string =>
  `${call.name} ${JSON.stringify(canonical(call.arguments))}`;

/** What the model saw: the error flag plus the result's content text (non-text blocks by type name). */
const resultKey = (result: ToolExecutionResult): string =>
  `${result.isError === true} ${(result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : block.type))
    .join("")}`;

export const repeatGuardExtension = (): Extension => {
  const guards = new Map<ConversationId, Guard>();
  const guardOf = (id: ConversationId): Guard => {
    let guard = guards.get(id);
    if (guard === undefined) {
      guard = { calls: new Map() };
      guards.set(id, guard);
    }
    return guard;
  };
  return defineExtension({
    name: "repeat-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          // A throwing hook becomes a `block` that kills the call: the guard must fail open.
          try {
            const guard = guardOf(api.conversationId);
            const live = await api.snapshot(
              LiveDoc,
              api.conversationId,
              context
            );
            // No live run means a task outlived its generation; keep the old key — the next
            // real run resets on its own first input anyway.
            const runKey =
              live?.run === undefined
                ? guard.runKey
                : String(live.run.inputs[0]);
            if (runKey !== guard.runKey) {
              guard.runKey = runKey;
              guard.calls.clear();
              guard.terminating = undefined;
            }
            if (guard.terminating !== undefined) {
              return;
            }
            const sig = signature(call);
            const entry = guard.calls.get(sig);
            const next = (entry?.repeats ?? 0) + 1;
            if (next >= TERMINATE_AT) {
              guard.terminating = sig;
              return;
            }
            if (next > BLOCK_AT) {
              // Blocked emissions count too: a stubborn model must still reach TERMINATE_AT.
              if (entry !== undefined) {
                entry.repeats = next;
              }
              return {
                block: `This identical ${call.name} call already produced the same result ${next - 1} times; repeating it produces nothing new — change the command or say what is blocking you. Repeating it again ends the run.`,
              };
            }
          } catch {
            // An empty decision blocks nothing and replaces no arguments.
            return {};
          }
        },
        afterTool: (call, result, api) => {
          try {
            const guard = guardOf(api.conversationId);
            const sig = signature(call);
            const key = resultKey(result);
            const streak = guard.calls.get(sig);
            const repeats = streak?.resultKey === key ? streak.repeats + 1 : 1;
            guard.calls.set(sig, { resultKey: key, repeats });
            if (guard.terminating === undefined) {
              return;
            }
            if (sig === guard.terminating && repeats < TERMINATE_AT) {
              // The flagged call's output changed: the run is making progress again.
              guard.terminating = undefined;
              return;
            }
            return {
              ...result,
              isError: true,
              diagnostics: [
                ...(result.diagnostics ?? []),
                {
                  severity: "error" as const,
                  code: REPEAT_GUARD_CODE,
                  message: `Ended the run: the identical ${call.name} call was emitted ${repeats} times with byte-identical output.`,
                },
              ],
              control: { ...result.control, terminate: true },
            };
          } catch {
            // Failing open keeps the result the execution already produced.
            return result;
          }
        },
      }),
    ],
  });
};

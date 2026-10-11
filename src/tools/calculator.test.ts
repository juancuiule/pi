import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ask, callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { calculate } from "./calculator.ts";

describe(calculate, () => {
  it.for([
    { op: "add", a: 2, b: 3, expected: 5 },
    { op: "subtract", a: 2, b: 3, expected: -1 },
    { op: "multiply", a: 6, b: 7, expected: 42 },
    { op: "divide", a: 1, b: 4, expected: 0.25 },
  ] as const)("$op($a, $b) = $expected", ({ op, a, b, expected }) => {
    expect(calculate(op, a, b)).toBe(expected);
  });

  it("rejects division by zero", () => {
    expect(() => calculate("divide", 1, 0)).toThrow("Division by zero");
  });
});

describe("calculator tool", () => {
  it("gives the model the result", async () => {
    const { faux, layer } = fauxAgents([
      callTool("calculate", { op: "multiply", a: 6, b: 7 }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("What is 6 times 7?").pipe(Effect.provide(layer))
    );

    expect(answer).toBe("42");
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  it("reports division by zero to the model as an error result", async () => {
    const { layer } = fauxAgents([
      callTool("calculate", { op: "divide", a: 1, b: 0 }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("What is 1 divided by 0?").pipe(Effect.provide(layer))
    );

    expect(answer).toContain("error:");
    expect(answer).toContain("Division by zero");
  });

  it("rejects arguments that do not match the schema", async () => {
    const { layer } = fauxAgents([
      callTool("calculate", { op: "power", a: 2, b: 8 }),
      echoToolResult,
    ]);

    const answer = await Effect.runPromise(
      ask("What is 2 to the 8th?").pipe(Effect.provide(layer))
    );

    expect(answer).toContain("error:");
  });
});

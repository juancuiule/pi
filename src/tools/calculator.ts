// A calculator tool: the model passes an operation and two numbers instead of an expression,
// so the harness validates the input and nothing is ever evaluated as code.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";

export type Operation = "add" | "subtract" | "multiply" | "divide";

export const calculate = (op: Operation, a: number, b: number): number => {
  switch (op) {
    case "add": {
      return a + b;
    }
    case "subtract": {
      return a - b;
    }
    case "multiply": {
      return a * b;
    }
    case "divide": {
      if (b === 0) {
        throw new RangeError("Division by zero");
      }
      return a / b;
    }
    default: {
      throw new TypeError(`Unknown operation: ${op satisfies never}`);
    }
  }
};

export const calculatorTool = defineTool({
  name: "calculate",
  description:
    "Apply an arithmetic operation to two numbers. Use it for any arithmetic instead of computing in your head.",
  parameters: Type.Object({
    op: Type.Union(
      [
        Type.Literal("add"),
        Type.Literal("subtract"),
        Type.Literal("multiply"),
        Type.Literal("divide"),
      ],
      { description: "The operation to apply" }
    ),
    a: Type.Number({ description: "The left operand" }),
    b: Type.Number({ description: "The right operand" }),
  }),
  // Pure, so rerunning after a crash is harmless.
  replay: "safe",
  // A rejection (for example on division by zero) gives the model an error result it can react to.
  // Promise.try turns a synchronous throw into that rejection.
  execute: ({ op, a, b }) =>
    Promise.try(() => ({
      content: [{ type: "text", text: String(calculate(op, a, b)) }],
    })),
});

export const Calculator: Extension = defineExtension({
  name: "calculator",
  tools: [calculatorTool],
});

// Desktop tools for a conversation with a desktop sandbox: the model takes a screenshot, looks at it, and acts with
// the mouse and keyboard. Commands run through the conversation's environment with xdotool and scrot.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

import { SandboxDoc } from "../sandbox/sandbox.ts";
import type { SaveScreenshot } from "../screenshots.ts";

const SCREENSHOT_PATH = "/tmp/effect-pi-screenshot.png";

export type MouseButton = "left" | "middle" | "right";
export type ScrollDirection = "up" | "down" | "left" | "right";

const BUTTONS: Record<MouseButton, string> = {
  left: "1",
  middle: "2",
  right: "3",
};
// X11 maps scrolling to buttons 4-7
const SCROLL_BUTTONS: Record<ScrollDirection, string> = {
  up: "4",
  down: "5",
  left: "6",
  right: "7",
};

// ─── Command builders (argv, never a shell string, so text reaches xdotool unparsed) ───

export const clickCommand = (input: {
  readonly x: number;
  readonly y: number;
  readonly button?: MouseButton;
  readonly clicks?: number;
}): string[] => [
  "xdotool",
  "mousemove",
  "--sync",
  String(Math.round(input.x)),
  String(Math.round(input.y)),
  "click",
  "--repeat",
  String(input.clicks ?? 1),
  BUTTONS[input.button ?? "left"],
];

export const typeCommand = (text: string): string[] => [
  "xdotool",
  "type",
  "--delay",
  "12",
  "--",
  text,
];

// Key names models use that are not X11 keysyms, lowercased.
const KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  control: "ctrl",
  cmd: "super",
  command: "super",
  win: "super",
  meta: "super",
  del: "Delete",
  delete: "Delete",
  backspace: "BackSpace",
  tab: "Tab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  home: "Home",
  end: "End",
};

/**
 * Repair key sequences the way models commonly get them wrong: a JSON array (`["ctrl+s", "Return"]`) instead of a
 * space-separated string, surrounding quotes, and key names such as `enter` or `control` that xdotool does not know.
 */
export const normalizeKeys = (keys: string): string => {
  let text = keys.trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        text = parsed.map(String).join(" ");
      }
    } catch {
      // Not JSON after all; use it as typed.
    }
  }
  return text
    .replaceAll(/["']/gu, "")
    .split(/[\s,]+/u)
    .filter((sequence) => sequence !== "")
    .map((sequence) =>
      sequence
        .split("+")
        .map((part) => KEY_ALIASES[part.toLowerCase()] ?? part)
        .join("+")
    )
    .join(" ");
};

export const keyCommand = (keys: string): string[] => [
  "xdotool",
  "key",
  "--",
  ...keys.split(/\s+/u).filter((key) => key !== ""),
];

export const scrollCommand = (input: {
  readonly x: number;
  readonly y: number;
  readonly direction: ScrollDirection;
  readonly amount?: number;
}): string[] => [
  "xdotool",
  "mousemove",
  "--sync",
  String(Math.round(input.x)),
  String(Math.round(input.y)),
  "click",
  "--repeat",
  String(input.amount ?? 3),
  SCROLL_BUTTONS[input.direction],
];

export const dragCommand = (input: {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}): string[] => [
  "xdotool",
  "mousemove",
  "--sync",
  String(Math.round(input.fromX)),
  String(Math.round(input.fromY)),
  "mousedown",
  "1",
  "mousemove",
  "--sync",
  String(Math.round(input.toX)),
  String(Math.round(input.toY)),
  "mouseup",
  "1",
];

// ─── Running commands in the sandbox ─────────────────────────────────────────

const requireEnv = (env: ExecutionEnv | undefined): ExecutionEnv => {
  if (env === undefined) {
    throw new Error(
      "This conversation has no desktop sandbox. Start it with sandbox: desktop."
    );
  }
  return env;
};

const run = async (
  env: ExecutionEnv | undefined,
  command: readonly string[],
  context: Context
): Promise<string> => {
  let output = "";
  const result = await requireEnv(env).exec(
    command,
    {
      onOutput: (text) => {
        output += text;
      },
    },
    context
  );
  if (!result.ok) {
    throw new Error(`${command[0]} failed: ${result.error.message}`);
  }
  if (result.value.exitCode !== 0) {
    throw new Error(
      `${command[0]} exited with ${result.value.exitCode}: ${output.trim()}`
    );
  }
  return output;
};

const done = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const coordinate = (description: string) =>
  Type.Number({ description, minimum: 0 });

// ─── Tools ───────────────────────────────────────────────────────────────────

const screenshotTool = (save: SaveScreenshot | undefined) =>
  defineTool({
    name: "desktop_screenshot",
    description:
      "Take a screenshot of the desktop. Do this before acting and after each action to see the result. Coordinates for the other desktop tools are pixels in this image.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const env = requireEnv(api.env);
      await run(env, ["scrot", "--overwrite", SCREENSHOT_PATH], context);
      const image = await env.readBinaryFile(SCREENSHOT_PATH, context);
      if (!image.ok) {
        throw new Error(
          `Could not read the screenshot: ${image.error.message}`
        );
      }
      const doc = await api.snapshot(SandboxDoc, api.conversationId, context);
      const savedTo = await save?.(image.value, {
        sandboxId: doc?.sandbox?.id ?? `conversation-${api.conversationId}`,
        conversationId: api.conversationId,
        callId: api.callId,
      });
      return {
        content: [
          {
            type: "image",
            data: Buffer.from(image.value).toString("base64"),
            mimeType: "image/png",
          },
        ],
        // Not shown to the model; where the host kept the image.
        ...(savedTo === undefined ? {} : { details: { savedTo } }),
      };
    },
  });

// Actions change the desktop, so a crash mid-call must not repeat them: no `replay: "safe"`.
const click = defineTool({
  name: "desktop_click",
  description: "Move the mouse to a point and click.",
  parameters: Type.Object({
    x: coordinate("Horizontal pixel position"),
    y: coordinate("Vertical pixel position"),
    button: Type.Optional(
      Type.Union(
        [Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")],
        { description: "Mouse button, left by default" }
      )
    ),
    clicks: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3,
        description: "1 for a click, 2 for a double click",
      })
    ),
  }),
  execute: async (args, api, context) => {
    await run(api.env, clickCommand(args), context);
    return done(`Clicked at (${args.x}, ${args.y}).`);
  },
});

const typeText = defineTool({
  name: "desktop_type",
  description:
    "Type text with the keyboard into the focused window. Use desktop_key for shortcuts and special keys.",
  parameters: Type.Object({
    text: Type.String({ description: "The text to type" }),
  }),
  execute: async (args, api, context) => {
    await run(api.env, typeCommand(args.text), context);
    return done(`Typed ${args.text.length} characters.`);
  },
});

const key = defineTool({
  name: "desktop_key",
  description:
    'Press keys or shortcuts, in xdotool syntax, separated by spaces: "Return", "ctrl+l", "ctrl+shift+t Tab".',
  parameters: Type.Object({
    keys: Type.String({ description: "Keys to press, in order" }),
  }),
  prepareArguments: (args) => {
    const { keys } = args as { keys?: unknown };
    return { keys: typeof keys === "string" ? normalizeKeys(keys) : "" };
  },
  execute: async (args, api, context) => {
    await run(api.env, keyCommand(args.keys), context);
    return done(`Pressed ${args.keys}.`);
  },
});

const scroll = defineTool({
  name: "desktop_scroll",
  description: "Scroll at a point.",
  parameters: Type.Object({
    x: coordinate("Horizontal pixel position"),
    y: coordinate("Vertical pixel position"),
    direction: Type.Union([
      Type.Literal("up"),
      Type.Literal("down"),
      Type.Literal("left"),
      Type.Literal("right"),
    ]),
    amount: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 20,
        description: "Scroll steps, 3 by default",
      })
    ),
  }),
  execute: async (args, api, context) => {
    await run(api.env, scrollCommand(args), context);
    return done(`Scrolled ${args.direction}.`);
  },
});

const drag = defineTool({
  name: "desktop_drag",
  description: "Drag with the left mouse button from one point to another.",
  parameters: Type.Object({
    fromX: coordinate("Start horizontal position"),
    fromY: coordinate("Start vertical position"),
    toX: coordinate("End horizontal position"),
    toY: coordinate("End vertical position"),
  }),
  execute: async (args, api, context) => {
    await run(api.env, dragCommand(args), context);
    return done(
      `Dragged from (${args.fromX}, ${args.fromY}) to (${args.toX}, ${args.toY}).`
    );
  },
});

/** The desktop tools. With `saveScreenshot`, every screenshot is also kept on the host. */
export const desktopExtension = (
  options: { readonly saveScreenshot?: SaveScreenshot } = {}
): Extension =>
  defineExtension({
    name: "desktop",
    tools: [
      screenshotTool(options.saveScreenshot),
      click,
      typeText,
      key,
      scroll,
      drag,
    ],
  });

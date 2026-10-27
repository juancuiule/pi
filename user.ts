// Accounts from the command line: `pnpm user add <name>`, `pnpm user passwd <name>`, `pnpm user list`. The first
// account comes from the console's setup screen (it adopts what predates accounts); later ones come from here.
// The password is read from the terminal without echo, or from stdin's first line when stdin is not a terminal.
import "varlock/auto-load";
import { createInterface } from "node:readline";

import { Effect } from "effect";

import { Auth } from "./src/auth/auth.ts";
import * as config from "./src/config.ts";

const USAGE = "Usage: pnpm user add <name> | passwd <name> | list";

/** The first line of piped stdin. */
const firstLine = async (): Promise<string> => {
  const lines = createInterface({ input: process.stdin });
  const first = await lines[Symbol.asyncIterator]().next();
  lines.close();
  return first.done === true ? "" : first.value;
};

/** One line typed with echo off. */
const typedSecret = (prompt: string): Promise<string> =>
  // oxlint-disable-next-line promise/avoid-new -- raw-mode keystrokes arrive as events; nothing returns a promise
  new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let typed = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf-8")) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(typed);
          return;
        }
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        typed = char === "\u007F" ? typed.slice(0, -1) : typed + char;
      }
    };
    process.stdin.on("data", onData);
  });

const readSecret = (prompt: string): Promise<string> =>
  process.stdin.isTTY ? typedSecret(prompt) : firstLine();

const newPassword = async (): Promise<string> => {
  const password = await readSecret("Password: ");
  if (process.stdin.isTTY && (await readSecret("Again: ")) !== password) {
    throw new Error("The passwords do not match.");
  }
  return password;
};

const [command, name] = process.argv.slice(2);

const program = Effect.gen(function* () {
  const auth = yield* Auth;
  switch (command) {
    case "list": {
      for (const user of yield* auth.users) {
        console.log(user.name);
      }
      return;
    }
    case "add":
    case "passwd": {
      if (name === undefined) {
        return yield* Effect.fail(new Error(USAGE));
      }
      const password = yield* Effect.promise(newPassword);
      if (command === "add") {
        yield* auth.addUser(name, password);
        console.log(`Added ${name}.`);
      } else {
        yield* auth.setPassword(name, password);
        console.log(`Changed the password of ${name}; their sessions ended.`);
      }
      return;
    }
    default: {
      return yield* Effect.fail(new Error(USAGE));
    }
  }
}).pipe(Effect.provide(Auth.local({ database: config.paths.db })));

try {
  await Effect.runPromise(program);
} catch (error) {
  console.error(
    typeof error === "object" && error !== null && "reason" in error
      ? String(error.reason)
      : String(error instanceof Error ? error.message : error)
  );
  process.exitCode = 1;
}

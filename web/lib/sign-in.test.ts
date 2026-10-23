import { describe, expect, it } from "vitest";

import { formProblem } from "./sign-in";

const form = (name: string, password: string, confirm = password) => ({
  name,
  password,
  confirm,
});

describe("creating the first account", () => {
  it("accepts a name and password within the rules, typed twice", () => {
    expect(formProblem("setup", form("juan", "correct horse"))).toBeUndefined();
  });

  it("names the first field that breaks a rule", () => {
    expect([
      formProblem("setup", form("Juan", "correct horse"))?.field,
      formProblem("setup", form("juan", "short"))?.field,
      formProblem("setup", form("juan", "correct horse", "correct hose"))
        ?.field,
    ]).toStrictEqual(["name", "password", "confirm"]);
  });

  it("says what the rule is", () => {
    expect(formProblem("setup", form("juan", "short"))?.message).toMatch(
      /8 to 256 characters/u
    );
  });
});

describe("signing in", () => {
  it("only asks for both fields, so older accounts still sign in", () => {
    expect([
      formProblem("login", form("Juan", "short")),
      formProblem("login", form("", "x"))?.field,
      formProblem("login", form("juan", ""))?.field,
    ]).toStrictEqual([undefined, "name", "password"]);
  });
});

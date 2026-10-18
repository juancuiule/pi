import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { memory as memoryStore } from "../storage/object-store.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { sourceContract } from "./source.contract.ts";
import { convergeBuiltin, SkillSource } from "./source.ts";
import type { SkillSourceError } from "./source.ts";

const nodeContext = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const keys = async (store: ObjectStore) => {
  const listed = await store.list("skills", "builtin/");
  return listed.map((object) => object.key);
};

describe("SkillSource.directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "effect-pi-skill-source-"));
  afterEach(() => {
    // Folders the suite's `put` wrote live under org/; seeded ones at the top level.
    rmSync(root, { recursive: true, force: true });
  });
  sourceContract({
    make: () => SkillSource.directory(root).pipe(Layer.provide(nodeContext)),
    seedBuiltin: (id, files) => {
      for (const [file, contents] of Object.entries(files)) {
        const target = path.join(root, id, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, contents);
      }
    },
  });
});

const idAndOrigin = (folder: { id: string; origin: string }) => [
  folder.id,
  folder.origin,
];

describe("SkillSource.directory with a separate org root", () => {
  let root = "";
  let orgRoot = "";
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(orgRoot, { recursive: true, force: true });
  });

  const layer = () =>
    SkillSource.directory(root, orgRoot).pipe(Layer.provide(nodeContext));
  const use = <A>(
    f: (source: SkillSource["Service"]) => Effect.Effect<A, SkillSourceError>
  ) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(SkillSource), f).pipe(
        Effect.provide(layer())
      )
    );

  it("writes and removes org folders under orgRoot, never under root", async () => {
    root = mkdtempSync(path.join(tmpdir(), "effect-pi-skill-root-"));
    orgRoot = mkdtempSync(path.join(tmpdir(), "effect-pi-skill-org-"));
    mkdirSync(path.join(root, "kept"), { recursive: true });
    writeFileSync(path.join(root, "kept", "SKILL.md"), "builtin");

    await use((source) => source.put("made", { "SKILL.md": "org" }));
    // A second put over an existing folder goes through the staging swap.
    await use((source) =>
      source.put("made", { "SKILL.md": "org2", "extra.md": "e" })
    );
    await use((source) => source.put("kept", { "SKILL.md": "shadow" }));
    const shadowing = await use((source) => source.list);
    // The writes went to orgRoot; root gained nothing but the seeded folders.
    const writes = {
      orgMade: existsSync(path.join(orgRoot, "made", "SKILL.md")),
      orgKept: existsSync(path.join(orgRoot, "kept", "SKILL.md")),
      // Staging and backup dirs are gone: every entry is a skill folder.
      orgEntries: readdirSync(orgRoot).toSorted(),
      root: readdirSync(root).toSorted(),
    };
    await use((source) => source.remove("made"));
    await use((source) => source.remove("kept"));
    const after = await use((source) => source.list);
    const keptText = new TextDecoder().decode(
      await use((source) => source.read("kept", "SKILL.md"))
    );

    expect({
      shadowing: shadowing.map(idAndOrigin),
      writes,
      after: after.map(idAndOrigin),
      keptText,
    }).toStrictEqual({
      shadowing: [
        ["kept", "overridden"],
        ["made", "org"],
      ],
      writes: {
        orgMade: true,
        orgKept: true,
        orgEntries: ["kept", "made"],
        root: ["kept"],
      },
      after: [["kept", "builtin"]],
      keptText: "builtin",
    });
  });

  it("migrates a legacy root/org into the org root, losing to a folder already there", async () => {
    root = mkdtempSync(path.join(tmpdir(), "effect-pi-skill-root-"));
    orgRoot = mkdtempSync(path.join(tmpdir(), "effect-pi-skill-org-"));
    mkdirSync(path.join(root, "kept"), { recursive: true });
    writeFileSync(path.join(root, "kept", "SKILL.md"), "builtin");
    // Checkout-era org skills under root/org: "old" moves over, "clash" loses to the newer copy.
    for (const [id, text] of [
      ["old", "legacy"],
      ["clash", "legacy"],
    ]) {
      mkdirSync(path.join(root, "org", id), { recursive: true });
      writeFileSync(path.join(root, "org", id, "SKILL.md"), text);
    }
    mkdirSync(path.join(orgRoot, "clash"), { recursive: true });
    writeFileSync(path.join(orgRoot, "clash", "SKILL.md"), "wins");

    const folders = await use((source) => source.list);

    expect({
      folders: folders.map(idAndOrigin),
      oldText: new TextDecoder().decode(
        await use((source) => source.read("old", "SKILL.md"))
      ),
      clashText: new TextDecoder().decode(
        await use((source) => source.read("clash", "SKILL.md"))
      ),
      root: readdirSync(root).toSorted(),
    }).toStrictEqual({
      folders: [
        ["clash", "org"],
        ["kept", "builtin"],
        ["old", "org"],
      ],
      oldText: "legacy",
      clashText: "wins",
      root: ["kept"],
    });
  });
});

describe("SkillSource.memory", () => {
  const files: Record<string, string | Uint8Array> = {};
  sourceContract({
    make: () => SkillSource.memory(files),
    seedBuiltin: (id, seeded) => {
      for (const [file, contents] of Object.entries(seeded)) {
        files[`builtin/${id}/${file}`] = contents;
      }
    },
  });

  it("treats bare <id>/<file> keys as builtin folders", async () => {
    const bare: Record<string, string | Uint8Array> = {
      "plain/SKILL.md": "x",
      "org/plain/SKILL.md": "shadowed",
    };
    const folders = await Effect.runPromise(
      Effect.flatMap(Effect.service(SkillSource), (source) => source.list).pipe(
        Effect.provide(SkillSource.memory(bare))
      )
    );
    expect(folders).toStrictEqual([
      { id: "plain", files: ["SKILL.md"], origin: "overridden" },
    ]);
    const text = await Effect.runPromise(
      Effect.flatMap(Effect.service(SkillSource), (source) =>
        source.read("plain", "SKILL.md")
      ).pipe(Effect.provide(SkillSource.memory(bare)))
    );
    expect(new TextDecoder().decode(text)).toBe("shadowed");
  });
});

describe("SkillSource.s3 over a memory ObjectStore", () => {
  const store = memoryStore();
  const bucket = "skills-contract";
  const encoder = new TextEncoder();
  sourceContract({
    make: async () => {
      await store.ensure(bucket);
      return SkillSource.s3(store, bucket);
    },
    seedBuiltin: (id, files) =>
      Promise.all(
        Object.entries(files).map(([file, contents]) =>
          store.put(
            bucket,
            `builtin/${id}/${file}`,
            typeof contents === "string" ? encoder.encode(contents) : contents
          )
        )
      ),
  });
});

describe("converging builtin/ from a directory", () => {
  let dir = "";
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (relative: string, contents: string) => {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };

  const converge = (store: ObjectStore, puts: { n: number }) =>
    Effect.runPromise(
      convergeBuiltin({
        store: {
          ...store,
          put: async (bucket, key, body) => {
            puts.n += 1;
            await store.put(bucket, key, body);
          },
        },
        bucket: "skills",
        dir,
      }).pipe(Effect.provide(nodeContext))
    );

  it("uploads new and changed files, removes stale keys, and a rerun is a no-op", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "effect-pi-converge-"));
    write("alpha/SKILL.md", "v1");
    write("alpha/scripts/run.sh", "run");
    write("beta/SKILL.md", "b");
    // Not builtin: dot folders and files, the writable org overlay, top-level files.
    write(".hidden/SKILL.md", "skip");
    write("alpha/.DS_Store", "skip");
    write("org/custom/SKILL.md", "skip");
    write("README.md", "skip");

    const store = memoryStore();
    await store.ensure("skills");
    const puts = { n: 0 };
    await converge(store, puts);

    expect({ keys: await keys(store), puts: puts.n }).toStrictEqual({
      keys: [
        "builtin/alpha/scripts/run.sh",
        "builtin/alpha/SKILL.md",
        "builtin/beta/SKILL.md",
      ],
      puts: 3,
    });

    await converge(store, puts);
    expect(puts.n).toBe(3);

    write("alpha/SKILL.md", "v2");
    write("alpha/added.md", "new");
    rmSync(path.join(dir, "beta"), { recursive: true });
    // Stale keys that merely prefix a kept one still go: removes are exact-key deletes.
    await store.put("skills", "builtin/alpha/added", Uint8Array.of(0));
    await converge(store, puts);

    const converged = await store.get("skills", "builtin/alpha/SKILL.md");
    // Only the changed SKILL.md and the new file upload; the stale beta and added keys are exact removes.
    expect({
      keys: await keys(store),
      skill: new TextDecoder().decode(converged),
      puts: puts.n,
    }).toStrictEqual({
      keys: [
        "builtin/alpha/added.md",
        "builtin/alpha/scripts/run.sh",
        "builtin/alpha/SKILL.md",
      ],
      skill: "v2",
      puts: 5,
    });
  });

  it("leaves builtin/ alone when the skills dir is missing", async () => {
    const store = memoryStore();
    await store.ensure("skills");
    await store.put("skills", "builtin/alpha/SKILL.md", Uint8Array.of(1));
    const puts = { n: 0 };
    dir = path.join(tmpdir(), "effect-pi-converge-missing");
    rmSync(dir, { recursive: true, force: true });

    await converge(store, puts);

    await expect(store.list("skills", "builtin/")).resolves.toStrictEqual([
      { key: "builtin/alpha/SKILL.md", size: 1 },
    ]);
    expect(puts.n).toBe(0);
  });
});

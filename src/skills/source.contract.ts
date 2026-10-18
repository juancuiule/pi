// The behavior every SkillSource must provide: folders in two namespaces (`builtin`, seeded through the backend,
// and `org`, written by `put`/`remove`), with an org folder shadowing a builtin one of the same id. source.test.ts
// runs this suite against directory(), memory() and s3() over a memory ObjectStore; source.s3.test.ts runs it
// against real SeaweedFS, where the same assertions must hold.
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import type { Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { SkillSource } from "./source.ts";
import type { SkillSourceError } from "./source.ts";

const folderId = () => `sk-${randomBytes(8).toString("hex")}`;

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The contract: `make` builds the source under test; `seedBuiltin` writes a folder into the read-only builtin
 * namespace behind the source's back (the source only ever writes `org`), so shadowing can be tested. Folder ids
 * are random per call so reruns and sibling implementations cannot collide.
 */
export const sourceContract = (options: {
  readonly make: () =>
    | Promise<Layer.Layer<SkillSource>>
    | Layer.Layer<SkillSource>;
  readonly seedBuiltin: (
    id: string,
    files: Record<string, string | Uint8Array>
  ) => unknown;
}) => {
  describe("the SkillSource contract", () => {
    let layer: Layer.Layer<SkillSource>;
    beforeAll(async () => {
      layer = await options.make();
    });

    const use = <A>(
      f: (source: SkillSource["Service"]) => Effect.Effect<A, SkillSourceError>
    ) =>
      Effect.runPromise(
        Effect.flatMap(Effect.service(SkillSource), f).pipe(
          Effect.provide(layer)
        )
      );

    it("lists folders sorted by id and reads their files", async () => {
      const ids = [folderId(), folderId()].toSorted();
      await options.seedBuiltin(ids[1], { "SKILL.md": "b" });
      await options.seedBuiltin(ids[0], {
        "SKILL.md": "a",
        "docs/guide.md": "deep",
      });

      const folders = await use((source) => source.list);

      expect(folders.map((folder) => folder.id)).toStrictEqual(
        folders.map((folder) => folder.id).toSorted()
      );
      expect(folders.find((folder) => folder.id === ids[0])).toStrictEqual({
        id: ids[0],
        files: ["SKILL.md", "docs/guide.md"],
        origin: "builtin",
      });
      expect(
        textOf(await use((source) => source.read(ids[0], "SKILL.md")))
      ).toBe("a");
      expect(
        textOf(await use((source) => source.read(ids[0], "docs/guide.md")))
      ).toBe("deep");
    });

    it("fails reads of a file that is not there", async () => {
      const id = folderId();
      await options.seedBuiltin(id, { "SKILL.md": "x" });

      const missing = await Effect.runPromise(
        Effect.service(SkillSource).pipe(
          Effect.flatMap((source) => source.read(id, "none.md")),
          Effect.flip,
          Effect.provide(layer)
        )
      );
      expect(missing).toMatchObject({ _tag: "SkillSourceError" });
    });

    it("put adds a folder list and read can see", async () => {
      const id = folderId();
      await use((source) =>
        source.put(id, { "SKILL.md": "org", "docs/a.md": "deep" })
      );

      const folders = await use((source) => source.list);
      expect(folders.find((folder) => folder.id === id)).toStrictEqual({
        id,
        files: ["SKILL.md", "docs/a.md"],
        origin: "org",
      });
      expect(textOf(await use((source) => source.read(id, "docs/a.md")))).toBe(
        "deep"
      );
    });

    it("put replaces the folder's previous files", async () => {
      const id = folderId();
      await use((source) =>
        source.put(id, { "SKILL.md": "first", "old.md": "gone" })
      );
      await use((source) => source.put(id, { "SKILL.md": "second" }));

      const folders = await use((source) => source.list);
      expect(folders.find((folder) => folder.id === id)?.files).toStrictEqual([
        "SKILL.md",
      ]);
      expect(textOf(await use((source) => source.read(id, "SKILL.md")))).toBe(
        "second"
      );
      const gone = await Effect.runPromise(
        Effect.service(SkillSource).pipe(
          Effect.flatMap((source) => source.read(id, "old.md")),
          Effect.flip,
          Effect.provide(layer)
        )
      );
      expect(gone).toMatchObject({ _tag: "SkillSourceError" });
    });

    it("an org folder shadows the builtin one in list and read", async () => {
      const id = folderId();
      await options.seedBuiltin(id, {
        "SKILL.md": "builtin",
        "only-builtin.md": "b",
      });
      await use((source) => source.put(id, { "SKILL.md": "org" }));

      const folders = await use((source) => source.list);
      expect(folders.find((folder) => folder.id === id)).toMatchObject({
        files: ["SKILL.md"],
        origin: "overridden",
      });
      expect(textOf(await use((source) => source.read(id, "SKILL.md")))).toBe(
        "org"
      );
      // A file the org copy does not shadow still reads its builtin one.
      expect(
        textOf(await use((source) => source.read(id, "only-builtin.md")))
      ).toBe("b");
    });

    it("remove deletes only the org copy, never the builtin folder", async () => {
      const shadowed = folderId();
      await options.seedBuiltin(shadowed, { "SKILL.md": "builtin" });
      await use((source) =>
        source.put(shadowed, { "SKILL.md": "org", "added.md": "a" })
      );
      const builtinOnly = folderId();
      await options.seedBuiltin(builtinOnly, { "SKILL.md": "builtin" });
      const orgOnly = folderId();
      await use((source) => source.put(orgOnly, { "SKILL.md": "org" }));

      await use((source) => source.remove(shadowed));
      await use((source) => source.remove(builtinOnly));
      await use((source) => source.remove(orgOnly));

      const folders = await use((source) => source.list);
      expect(
        folders.find((folder) => folder.id === shadowed)?.files
      ).toStrictEqual(["SKILL.md"]);
      expect(
        folders.find((folder) => folder.id === builtinOnly)?.files
      ).toStrictEqual(["SKILL.md"]);
      expect(folders.some((folder) => folder.id === orgOnly)).toBe(false);
      expect(
        textOf(await use((source) => source.read(shadowed, "SKILL.md")))
      ).toBe("builtin");
    });

    it.each(["../escape", "a/b", "", "..", ".", ".hidden", "has\\backslash"])(
      "rejects put and remove of the folder id %j",
      async (id) => {
        const put = await Effect.runPromise(
          Effect.service(SkillSource).pipe(
            Effect.flatMap((source) => source.put(id, { "SKILL.md": "x" })),
            Effect.flip,
            Effect.provide(layer)
          )
        );
        expect(put).toMatchObject({ _tag: "SkillSourceError" });
        const remove = await Effect.runPromise(
          Effect.service(SkillSource).pipe(
            Effect.flatMap((source) => source.remove(id)),
            Effect.flip,
            Effect.provide(layer)
          )
        );
        expect(remove).toMatchObject({ _tag: "SkillSourceError" });
      }
    );

    it.each([
      "../x.md",
      "a/../x.md",
      "a//b.md",
      "a\\b.md",
      ".",
      "..",
      ".hidden.md",
      "a/.hidden.md",
      "",
    ])("rejects put of the file path %j", async (file) => {
      const id = folderId();
      const failed = await Effect.runPromise(
        Effect.service(SkillSource).pipe(
          Effect.flatMap((source) =>
            source.put(id, { "SKILL.md": "x", [file]: "v" })
          ),
          Effect.flip,
          Effect.provide(layer)
        )
      );
      expect(failed).toMatchObject({ _tag: "SkillSourceError" });
      // Nothing was written: the folder never appears.
      const folders = await use((source) => source.list);
      expect(folders.some((folder) => folder.id === id)).toBe(false);
      const read = await Effect.runPromise(
        Effect.service(SkillSource).pipe(
          Effect.flatMap((source) => source.read(folderId(), file)),
          Effect.flip,
          Effect.provide(layer)
        )
      );
      expect(read).toMatchObject({ _tag: "SkillSourceError" });
    });
  });
};

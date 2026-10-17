import { describe, expect, it } from "vitest";

import { storeContract } from "./object-store.contract.ts";
import { memory } from "./object-store.ts";

storeContract(() => memory());

describe(memory, () => {
  it("keeps buckets apart", async () => {
    const store = memory();
    await store.put("a", "key", Uint8Array.of(1));
    await store.put("b", "key", Uint8Array.of(2));
    await expect(store.get("a", "key")).resolves.toStrictEqual(
      Uint8Array.of(1)
    );
    await expect(store.get("b", "key")).resolves.toStrictEqual(
      Uint8Array.of(2)
    );
  });

  it("does not let callers mutate stored bytes through the ones they put", async () => {
    const store = memory();
    const bytes = Uint8Array.of(1);
    await store.put("a", "key", bytes);
    bytes[0] = 9;
    await expect(store.get("a", "key")).resolves.toStrictEqual(
      Uint8Array.of(1)
    );
  });
});

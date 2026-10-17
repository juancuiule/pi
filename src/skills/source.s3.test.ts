// The SkillSource contract against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// A per-run bucket keeps the suite from clobbering a real `skills` bucket.
import { randomBytes } from "node:crypto";

import { afterAll, describe } from "vitest";

import { s3GatewayUp, s3TestStore } from "../testing/s3.ts";
import { sourceContract } from "./source.contract.ts";
import { SkillSource } from "./source.ts";

describe.skipIf(!(await s3GatewayUp()))(
  "the S3 skill source",
  { timeout: 120_000 },
  () => {
    const store = s3TestStore();
    const bucket = `skills-${randomBytes(8).toString("hex")}`;
    const encoder = new TextEncoder();

    afterAll(async () => {
      await store.removePrefix(bucket, "");
    });

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
  }
);

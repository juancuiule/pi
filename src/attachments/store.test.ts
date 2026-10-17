import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe } from "vitest";

import { memory } from "../storage/object-store.ts";
import { blobContract } from "./store.contract.ts";
import { directoryBlobs, s3Blobs } from "./store.ts";

describe(directoryBlobs, () => {
  const root = mkdtempSync(path.join(tmpdir(), "blobs-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  blobContract(() => directoryBlobs(root));
});

blobContract(() => s3Blobs(memory(), "test"));

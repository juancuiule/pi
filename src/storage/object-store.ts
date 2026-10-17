// Object storage behind one small interface, so attachments, skills, screenshots and workspaces can move from
// local directories to S3 one adapter at a time (docs/plans/object-storage.md). `s3()` talks to a real endpoint
// (SeaweedFS's gateway locally, `pnpm seaweed:up`); `memory()` is for tests. Methods take the bucket explicitly:
// each adapter names its own bucket from BUCKETS.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/** The buckets the server ensures at startup; every consumer names them here. */
export const BUCKETS = {
  attachments: "attachments",
  skills: "skills",
  screenshots: "screenshots",
  workspaces: "workspaces",
  litestream: "litestream",
} as const;

/** What `put` accepts: bytes in memory, a readable stream, or a local file to stream (never buffered). */
export type PutBody = Uint8Array | Readable | { readonly path: string };

/** Bytes by bucket and key, like `BlobStore` in src/attachments/store.ts but over S3. */
export interface ObjectStore {
  /** Store `body` under `key`, streaming streams and files. */
  put(bucket: string, key: string, body: PutBody): Promise<void>;
  /** The bytes under `key`; `undefined` when the key or bucket is missing. */
  get(bucket: string, key: string): Promise<Uint8Array | undefined>;
  /** A stream of the bytes under `key` (for workspace tars); `undefined` like `get`. */
  read(bucket: string, key: string): Promise<Readable | undefined>;
  /** The keys under `prefix` and their sizes, all pages. */
  list(
    bucket: string,
    prefix: string
  ): Promise<readonly { key: string; size: number }[]>;
  /** Delete everything under `prefix`. */
  removePrefix(bucket: string, prefix: string): Promise<void>;
  /** Create the bucket when it is missing. */
  ensure(bucket: string): Promise<void>;
  /** Expire every object in the bucket after `days` (a lifecycle rule). */
  setExpiration(bucket: string, days: number): Promise<void>;
}

interface S3Error {
  readonly name?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

/** The key (or bucket) is not there: the SDK reports `NoSuchKey`/`NoSuchBucket`, and SeaweedFS a bare 404. */
const isMissing = (error: unknown) => {
  const { name, $metadata } = error as S3Error;
  return (
    name === "NoSuchKey" ||
    name === "NoSuchBucket" ||
    $metadata?.httpStatusCode === 404
  );
};

const DELETE_PAGE = 1000;

/** An ObjectStore over an S3 endpoint; path-style with a fixed region, which SeaweedFS's gateway expects. */
export const s3 = (options: {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): ObjectStore => {
  const client = new S3Client({
    endpoint: options.endpoint,
    forcePathStyle: true,
    region: "us-east-1",
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
  return {
    put: async (bucket, key, body) => {
      if (body instanceof Uint8Array) {
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: body })
        );
        return;
      }
      const stream = "path" in body ? createReadStream(body.path) : body;
      await new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: stream },
      }).done();
    },
    get: async (bucket, key) => {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        return await response.Body?.transformToByteArray();
      } catch (error) {
        if (isMissing(error)) {
          return;
        }
        throw error;
      }
    },
    read: async (bucket, key) => {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        return response.Body as Readable | undefined;
      } catch (error) {
        if (isMissing(error)) {
          return;
        }
        throw error;
      }
    },
    list: async (bucket, prefix) => {
      const keys: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- each page's token comes from the previous page
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          })
        );
        for (const object of page.Contents ?? []) {
          if (object.Key !== undefined) {
            keys.push({ key: object.Key, size: object.Size ?? 0 });
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return keys;
    },
    removePrefix: async (bucket, prefix) => {
      let token: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- each page's token comes from the previous page
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          })
        );
        const objects = (page.Contents ?? []).flatMap((object) =>
          object.Key === undefined ? [] : [{ Key: object.Key }]
        );
        for (let from = 0; from < objects.length; from += DELETE_PAGE) {
          // oxlint-disable-next-line no-await-in-loop -- deletes of one page finish before the next list page
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects.slice(from, from + DELETE_PAGE) },
            })
          );
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
    },
    ensure: async (bucket) => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    setExpiration: async (bucket, days) => {
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: "expire",
                Status: "Enabled",
                Filter: { Prefix: "" },
                Expiration: { Days: days },
              },
            ],
          },
        })
      );
    },
  };
};

const collect = async (body: Readable): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks);
};

/* oxlint-disable require-await -- the interface is async; the memory store has nothing to await */
/** An ObjectStore over a Map, for tests. Buckets are created on `ensure` or first `put`. */
export const memory = (): ObjectStore => {
  const buckets = new Map<string, Map<string, Uint8Array>>();
  const bucketOf = (bucket: string) => {
    let objects = buckets.get(bucket);
    if (objects === undefined) {
      objects = new Map();
      buckets.set(bucket, objects);
    }
    return objects;
  };
  return {
    put: async (bucket, key, body) => {
      const bytes =
        body instanceof Uint8Array
          ? body
          : await collect("path" in body ? createReadStream(body.path) : body);
      bucketOf(bucket).set(key, new Uint8Array(bytes));
    },
    get: async (bucket, key) => {
      const bytes = bucketOf(bucket).get(key);
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
    read: async (bucket, key) => {
      const bytes = bucketOf(bucket).get(key);
      // Readable.from over a single-element array yields the whole chunk, not its bytes.
      return bytes === undefined ? undefined : Readable.from([bytes]);
    },
    list: async (bucket, prefix) =>
      [...bucketOf(bucket).entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, size: bytes.length }))
        .toSorted((a, b) => a.key.localeCompare(b.key)),
    removePrefix: async (bucket, prefix) => {
      for (const key of bucketOf(bucket).keys()) {
        if (key.startsWith(prefix)) {
          bucketOf(bucket).delete(key);
        }
      }
    },
    ensure: async (bucket) => {
      bucketOf(bucket);
    },
    setExpiration: () => Promise.resolve(),
  };
};
/* oxlint-enable require-await */

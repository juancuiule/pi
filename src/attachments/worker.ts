// Untrusted files are parsed in a worker thread of their own (see extract.ts), never in the server's thread: each job
// starts one with a memory limit, terminates it after a timeout, and turns its answer back into a value or an
// `ExtractionRefusedError`. Two jobs: preparing an upload, and drawing a PDF page for the console.
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

import type { Extracted, ExtractInput, RenderInput } from "./extract.ts";
import { extract, ExtractionRefusedError, renderPdfPage } from "./extract.ts";

type Job =
  | { readonly type: "extract"; readonly input: ExtractInput }
  | { readonly type: "render"; readonly input: RenderInput };

type Reply =
  | { readonly ok: true; readonly value: Extracted | Uint8Array }
  | {
      readonly ok: false;
      readonly reason: ExtractionRefusedError["reason"];
      readonly message: string;
    };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The bytes a value holds, transferred to the server's thread rather than copied. */
const buffersOf = (value: Extracted | Uint8Array) =>
  (value instanceof Uint8Array
    ? [value.buffer]
    : [value.modelImage?.buffer, value.thumbnail?.buffer]
  ).flatMap((buffer) => (buffer instanceof ArrayBuffer ? [buffer] : []));

/** In the worker: run the job, and post the outcome back. */
const respond = async (port: MessagePort, job: Job) => {
  try {
    const value =
      job.type === "extract"
        ? await extract(job.input)
        : await renderPdfPage(job.input);
    port.postMessage({ ok: true, value } satisfies Reply, buffersOf(value));
  } catch (error) {
    port.postMessage(
      (error instanceof ExtractionRefusedError
        ? { ok: false, reason: error.reason, message: error.message }
        : {
            ok: false,
            reason: "failed",
            message: `The file could not be read: ${messageOf(error)}`,
          }) satisfies Reply
    );
  }
};

if (!isMainThread && parentPort !== null) {
  void respond(parentPort, workerData as Job);
}

const reply = async (worker: Worker, signal: AbortSignal) => {
  const [message] = (await once(worker, "message", { signal })) as [Reply];
  return message;
};

const timeout = async (ms: number, signal: AbortSignal) => {
  await sleep(ms, undefined, { signal });
  return new ExtractionRefusedError(
    "too_large",
    `Reading the file took longer than ${Math.round(ms / 1000)}s.`
  );
};

const exit = async (worker: Worker, signal: AbortSignal) => {
  const [code] = (await once(worker, "exit", { signal })) as [number];
  return new ExtractionRefusedError(
    "failed",
    `The file could not be read (the reader stopped with ${code}).`
  );
};

export interface WorkerLimits {
  readonly timeoutMs: number;
  readonly memoryMb: number;
}

/** Run `job` in a new worker thread; rejects with `ExtractionRefusedError`. */
const run = async (
  job: Job,
  options: WorkerLimits
): Promise<Extracted | Uint8Array> => {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: job,
    resourceLimits: { maxOldGenerationSizeMb: options.memoryMb },
  });
  const done = new AbortController();
  try {
    const outcome = await Promise.race([
      reply(worker, done.signal),
      timeout(options.timeoutMs, done.signal),
      exit(worker, done.signal),
    ]);
    if (outcome instanceof ExtractionRefusedError) {
      throw outcome;
    }
    if (!outcome.ok) {
      throw new ExtractionRefusedError(outcome.reason, outcome.message);
    }
    return outcome.value;
  } catch (error) {
    if (error instanceof ExtractionRefusedError) {
      throw error;
    }
    // An `error` event: the worker crashed, most likely out of memory.
    const message = messageOf(error);
    throw message.includes("memory")
      ? new ExtractionRefusedError(
          "too_large",
          "Reading the file needed more memory than allowed."
        )
      : new ExtractionRefusedError(
          "failed",
          `The file could not be read: ${message}`
        );
  } finally {
    done.abort();
    await worker.terminate();
  }
};

/** Prepare an upload in a new worker thread. */
export const runExtraction = async (
  input: ExtractInput,
  options: WorkerLimits
): Promise<Extracted> =>
  (await run({ type: "extract", input }, options)) as Extracted;

/** Draw one PDF page as a WebP image in a new worker thread. */
export const runPageRender = async (
  input: RenderInput,
  options: WorkerLimits
): Promise<Uint8Array> =>
  (await run({ type: "render", input }, options)) as Uint8Array;

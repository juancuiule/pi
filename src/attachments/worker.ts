// One extraction in a worker thread of its own (see extract.ts): `runExtraction` starts it with a memory limit,
// terminates it after a timeout, and turns its answer back into an `Extracted` or an `ExtractionRefusedError`.
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

import type { Extracted, ExtractInput } from "./extract.ts";
import { extract, ExtractionRefusedError } from "./extract.ts";

type Reply =
  | { readonly ok: true; readonly extracted: Extracted }
  | {
      readonly ok: false;
      readonly reason: ExtractionRefusedError["reason"];
      readonly message: string;
    };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** In the worker: extract, and post the outcome back; images' bytes are transferred, not copied. */
const respond = async (port: MessagePort, input: ExtractInput) => {
  try {
    const extracted = await extract(input);
    const transfer = [
      extracted.modelImage?.buffer,
      extracted.thumbnail?.buffer,
    ].flatMap((buffer) => (buffer instanceof ArrayBuffer ? [buffer] : []));
    port.postMessage({ ok: true, extracted } satisfies Reply, transfer);
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
  void respond(parentPort, workerData as ExtractInput);
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

/** Prepare an upload in a new worker thread; rejects with `ExtractionRefusedError`. */
export const runExtraction = async (
  input: ExtractInput,
  options: { readonly timeoutMs: number; readonly memoryMb: number }
): Promise<Extracted> => {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: input,
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
    return outcome.extracted;
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

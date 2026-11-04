// oxlint-disable no-await-in-loop -- polling the health check, one request at a time
// `pnpm speaches:up`: starts the local Speaches for dictation, on the GPU when Docker has the NVIDIA runtime and on
// the CPU otherwise (or with --cpu), waits until it has downloaded its model, loads the model with a first request,
// and writes TRANSCRIBE_URL and TRANSCRIBE_MODEL to the root .env when they are not set yet. Later runs keep the
// existing values. See README.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const here = import.meta.dirname;
const appEnv = path.join(here, "..", "..", ".env");
const port = process.env.SPEACHES_PORT ?? "8000";
const base = `http://127.0.0.1:${port}`;

/** The default model for each device: large-v3-turbo fits an 8 GB GPU in int8; small keeps a CPU near real time. */
const DEFAULT_MODEL = {
  gpu: "deepdml/faster-whisper-large-v3-turbo-ct2",
  cpu: "Systran/faster-whisper-small",
} as const;

const readEnv = (file: string): Record<string, string> =>
  existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, "utf-8")
          .split("\n")
          .filter((line) => line.includes("=") && !line.startsWith("#"))
          .map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
          })
      )
    : {};

/** Whether Docker can hand a GPU to a container: the NVIDIA runtime is registered (nvidia-container-toolkit). */
const dockerHasGpu = (): boolean => {
  try {
    const runtimes = execFileSync(
      "docker",
      ["info", "--format", "{{json .Runtimes}}"],
      { encoding: "utf-8" }
    );
    return runtimes.includes("nvidia");
  } catch {
    return false;
  }
};

const hasNvidiaGpu = (): boolean => {
  try {
    execFileSync("nvidia-smi", ["-L"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const forceCpu = process.argv.includes("--cpu");
const gpu = !forceCpu && dockerHasGpu();
if (!gpu && !forceCpu && hasNvidiaGpu()) {
  console.warn(
    "This host has an NVIDIA GPU, but Docker has no NVIDIA runtime: starting Speaches on the CPU.\n" +
      "Install nvidia-container-toolkit and run `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`\n" +
      "(docker/speaches/README.md), then `pnpm speaches:down && pnpm speaches:up`."
  );
}

const values = readEnv(appEnv);
const device = gpu ? "gpu" : "cpu";
const model =
  values.TRANSCRIBE_MODEL !== undefined && values.TRANSCRIBE_MODEL !== ""
    ? values.TRANSCRIBE_MODEL
    : DEFAULT_MODEL[device];

const files = ["-f", path.join(here, "docker-compose.yml")];
if (gpu) {
  files.push("-f", path.join(here, "docker-compose.gpu.yml"));
}
execFileSync("docker", ["compose", ...files, "-p", "speaches", "up", "-d"], {
  stdio: "inherit",
  env: { ...process.env, SPEACHES_MODEL: model, SPEACHES_PORT: port },
});

// The first start downloads the model before Speaches answers: a large one takes minutes.
console.log(`Waiting for Speaches on ${base} (downloading ${model})...`);
const deadline = Date.now() + 30 * 60_000;
for (;;) {
  try {
    const health = await fetch(`${base}/health`);
    if (health.ok) {
      break;
    }
  } catch {
    // Not listening yet.
  }
  if (Date.now() > deadline) {
    throw new Error(
      "Speaches did not come up in 30 minutes: docker compose -p speaches logs"
    );
  }
  await sleep(2000);
}

// One second of silence as WAV: the first request loads the model, so a dictation does not wait for it.
const silentWav = () => {
  const rate = 16_000;
  const bytes = new Uint8Array(44 + rate * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.codePointAt(index) ?? 0);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + rate * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, rate * 2, true);
  return bytes;
};
const form = new FormData();
form.set("file", new Blob([silentWav()], { type: "audio/wav" }), "warmup.wav");
form.set("model", model);
const started = Date.now();
const warmup = await fetch(`${base}/v1/audio/transcriptions`, {
  method: "POST",
  body: form,
});
if (!warmup.ok) {
  throw new Error(
    `Speaches could not load ${model}: ${warmup.status} ${await warmup.text()}`
  );
}
console.log(`Loaded ${model} on the ${device} in ${Date.now() - started} ms`);

if (values.TRANSCRIBE_URL === undefined || values.TRANSCRIBE_URL === "") {
  const existing = existsSync(appEnv) ? readFileSync(appEnv, "utf-8") : "";
  const lines = [`TRANSCRIBE_URL=${base}/v1`];
  if (values.TRANSCRIBE_MODEL === undefined || values.TRANSCRIBE_MODEL === "") {
    lines.push(`TRANSCRIBE_MODEL=${model}`);
  }
  writeFileSync(
    appEnv,
    `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`
  );
  console.log(
    `Added ${lines.map((line) => line.split("=")[0]).join(" and ")} to ${path.relative(process.cwd(), appEnv)}; restart the server`
  );
}

console.log(`Speaches: ${base}/v1 (${device}, ${model})`);

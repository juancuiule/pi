// oxlint-disable no-await-in-loop -- one request at a time on purpose: concurrent ones would skew the latency measured
// `pnpm speaches:compare <folder>`: runs every clip in a folder through the local Speaches models worth comparing on
// an 8 GB GPU and prints each transcript with its latency, plus the word error rate when a reference sits beside the
// clip (`clip.txt` next to `clip.wav`). The language comes from the clip's folder or name prefix (`es/…`, `en/…`,
// `es-…`, `en-…`); `--auto` also runs each clip with the language detected. A JSON report is written into the folder.
// Speaches must be running (`pnpm speaches:up`); each model is downloaded on first use. See README.md.
//
//   pnpm speaches:compare ~/dictation-clips
//   pnpm speaches:compare ~/dictation-clips --models Systran/faster-whisper-small,deepdml/faster-whisper-large-v3-turbo-ct2
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: "string" },
    auto: { type: "boolean", default: false },
    url: {
      type: "string",
      default: `http://127.0.0.1:${process.env.SPEACHES_PORT ?? "8000"}`,
    },
  },
});

/** Multilingual models that fit 8 GB in int8, smallest first; distil-large-v3 is English only. */
const MODELS: readonly { readonly id: string; readonly englishOnly?: true }[] =
  [
    { id: "Systran/faster-whisper-small" },
    { id: "Systran/faster-whisper-medium" },
    { id: "deepdml/faster-whisper-large-v3-turbo-ct2" },
    { id: "Systran/faster-whisper-large-v3" },
    { id: "Systran/faster-distil-whisper-large-v3", englishOnly: true },
  ];

const AUDIO = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".webm",
  ".ogg",
  ".opus",
  ".flac",
]);

const [folder] = positionals;
if (folder === undefined) {
  console.error(
    "Usage: pnpm speaches:compare <folder of clips> [--models a,b] [--auto]"
  );
  process.exit(2);
}
const base = flags.url.replace(/\/+$/u, "");

const clipsIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return clipsIn(full);
    }
    return AUDIO.has(path.extname(name).toLowerCase()) ? [full] : [];
  });

const languageOf = (clip: string): "es" | "en" | undefined => {
  const parts = path.relative(folder, clip).toLowerCase().split(path.sep);
  for (const part of parts) {
    if (part === "es" || part.startsWith("es-") || part.startsWith("es_")) {
      return "es";
    }
    if (part === "en" || part.startsWith("en-") || part.startsWith("en_")) {
      return "en";
    }
  }
  return undefined;
};

const referenceOf = (clip: string): string | undefined => {
  try {
    return readFileSync(clip.replace(/\.[^.]+$/u, ".txt"), "utf-8");
  } catch {
    return undefined;
  }
};

/** Lowercase words without punctuation; accents count, since a missing tilde is an error a reader sees. */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/u)
    .filter((word) => word !== "");

/** Word error rate: word-level edit distance over the reference's length. */
const wer = (reference: string, hypothesis: string): number => {
  const ref = wordsOf(reference);
  const hyp = wordsOf(hypothesis);
  let previous = Array.from({ length: hyp.length + 1 }, (_, index) => index);
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return ref.length === 0 ? 0 : (previous[hyp.length] ?? 0) / ref.length;
};

const transcribe = async (
  model: string,
  clip: string,
  language: string | undefined
) => {
  const form = new FormData();
  form.set("file", new Blob([readFileSync(clip)]), path.basename(clip));
  form.set("model", model);
  form.set("response_format", "verbose_json");
  form.set("temperature", "0");
  if (language !== undefined) {
    form.set("language", language);
  }
  const started = performance.now();
  const response = await fetch(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });
  const ms = Math.round(performance.now() - started);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    text: string;
    duration?: number;
    language?: string;
  };
  return {
    ms,
    text: body.text.trim(),
    duration: body.duration,
    detected: body.language,
  };
};

const median = (values: readonly number[]) => {
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
const mean = (values: readonly number[]) =>
  values.length === 0
    ? Number.NaN
    : values.reduce((sum, value) => sum + value, 0) / values.length;
const percent = (value: number) =>
  Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`;

const clips = clipsIn(folder).toSorted();
if (clips.length === 0) {
  console.error(`No audio clips (${[...AUDIO].join(", ")}) under ${folder}`);
  process.exit(2);
}
const requested = flags.models?.split(",").map((id) => id.trim());
const models =
  requested === undefined
    ? MODELS
    : requested.map((id) => MODELS.find((each) => each.id === id) ?? { id });

interface Row {
  model: string;
  clip: string;
  language: string;
  ms: number;
  seconds: number | undefined;
  wer: number | undefined;
  text: string;
  detected: string | undefined;
}
const rows: Row[] = [];

for (const { id, englishOnly } of models) {
  console.log(`\n## ${id}`);
  const download = await fetch(`${base}/v1/models/${id}`, { method: "POST" });
  if (!download.ok && download.status !== 409) {
    console.error(
      `  could not download: ${download.status} ${await download.text()}`
    );
    continue;
  }
  // The first request loads the model; it is not measured.
  const [first] = clips;
  if (first !== undefined) {
    await transcribe(id, first, languageOf(first)).catch(() => null);
  }
  for (const clip of clips) {
    const pinned = languageOf(clip);
    if (englishOnly === true && pinned !== "en") {
      continue;
    }
    const runs =
      flags.auto && pinned !== undefined ? [pinned, undefined] : [pinned];
    for (const language of runs) {
      const reference = referenceOf(clip);
      try {
        const result = await transcribe(id, clip, language);
        const row: Row = {
          model: id,
          clip: path.relative(folder, clip),
          language: language ?? "auto",
          ms: result.ms,
          seconds: result.duration,
          wer:
            reference === undefined ? undefined : wer(reference, result.text),
          text: result.text,
          detected: result.detected,
        };
        rows.push(row);
        console.log(
          `  ${row.clip} [${row.language}${language === undefined ? ` → ${row.detected ?? "?"}` : ""}] ${row.ms} ms` +
            `${row.seconds === undefined ? "" : ` for ${row.seconds.toFixed(1)} s`}` +
            `${row.wer === undefined ? "" : `, WER ${percent(row.wer)}`}\n    ${row.text}`
        );
      } catch (error) {
        console.error(`  ${path.relative(folder, clip)}: ${String(error)}`);
      }
    }
  }
}

console.log(
  "\n## Summary (latency is one whole clip; dictation sends segments of a few seconds)\n"
);
console.log(
  "| model | language | clips | median ms | real-time factor | WER |"
);
console.log("| --- | --- | ---: | ---: | ---: | ---: |");
for (const { id } of models) {
  for (const language of ["es", "en", "auto"]) {
    const own = rows.filter(
      (row) => row.model === id && row.language === language
    );
    if (own.length === 0) {
      continue;
    }
    const factors = own.flatMap((row) =>
      row.seconds === undefined || row.seconds === 0
        ? []
        : [row.ms / 1000 / row.seconds]
    );
    const errors = own.flatMap((row) =>
      row.wer === undefined ? [] : [row.wer]
    );
    console.log(
      `| ${id} | ${language} | ${own.length} | ${median(own.map((row) => row.ms))} | ${mean(factors).toFixed(2)} | ${percent(mean(errors))} |`
    );
  }
}

const report = path.join(
  folder,
  `compare-${new Date().toISOString().replaceAll(":", "-")}.json`
);
writeFileSync(report, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`\nWrote ${report}`);

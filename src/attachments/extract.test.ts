import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { image, textPdf } from "../testing/files.ts";
import type { ExtractLimits } from "./extract.ts";
import { ExtractionRefusedError } from "./extract.ts";
import type { AttachmentKind } from "./format.ts";
import { runExtraction } from "./worker.ts";

const LIMITS: ExtractLimits = {
  maxPdfPages: 5,
  maxImagePixels: 4_000_000,
  modelImageEdge: 100,
  thumbnailEdge: 20,
};

const ENOUGH = { timeoutMs: 20_000, memoryMb: 256 };

/** Extract `contents` from a temporary file of their own. */
const run = async (
  kind: AttachmentKind,
  contents: string | Uint8Array,
  mediaType = "",
  options = ENOUGH
) => {
  const dir = mkdtempSync(path.join(tmpdir(), "extract-"));
  const file = path.join(dir, "file");
  writeFileSync(file, contents);
  try {
    return await runExtraction(
      { path: file, kind, mediaType, limits: LIMITS },
      options
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const refusal = async (promise: Promise<unknown>) => {
  const outcome: unknown = await promise.catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(ExtractionRefusedError);
  return outcome as ExtractionRefusedError;
};

// Uploads are read in worker threads that load pdf.js or sharp; on a busy machine (the git hooks run checks in
// parallel) starting one takes longer than vitest's default 5s.
const WORKERS = { timeout: 30_000 };

describe("extraction in a worker", WORKERS, () => {
  it("reads text, normalizing line ends", async () => {
    const { prepared } = await run(
      "text",
      "# Notes\r\n\r\n\r\n\r\nfirst   \r\nsecond"
    );
    expect(prepared.pages).toStrictEqual(["# Notes\n\nfirst\nsecond"]);
    expect(prepared.warnings).toStrictEqual([]);
  });

  it("reads Windows-1252 text with a warning, and refuses binary data", async () => {
    const { prepared } = await run(
      "text",
      new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    );
    expect(prepared.pages).toStrictEqual(["café"]);
    expect(prepared.warnings[0]).toContain("Windows-1252");
    const refused = await refusal(
      run("text", new Uint8Array([0x00, 0x01, 0x02, 0x03]))
    );
    expect(refused.reason).toBe("unsupported");
  });

  const html = `<html><head><title>Report</title><style>p{color:red}</style><script>alert(1)</script></head>
       <body><h1>Results</h1><p>Growth was <b>3%</b>, see <a href="https://example.com/data">the data</a>.</p>
       <ul><li>one</li><li>two</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
       <a href="javascript:alert(1)">click</a><img src="x.png" alt="A chart"></body></html>`;

  it("reads HTML as text: headings, links, lists, tables and alt text", async () => {
    const { prepared } = await run("html", html);
    const text = prepared.pages[0] ?? "";
    expect(
      [
        "Title: Report",
        "# Results",
        "Growth was 3%, see the data (https://example.com/data).",
        "- one\n- two",
        "| a | b |\n| 1 | 2 |",
        "[image: A chart]",
      ].filter((part) => !text.includes(part))
    ).toStrictEqual([]);
    expect(prepared.extractor).toMatch(/^htmlparser2@\d/u);
  });

  it("leaves out scripts, styles and javascript: links", async () => {
    const { prepared } = await run("html", html);
    expect(prepared.pages[0]).not.toMatch(/alert|color/u);
  });

  it("reads a PDF page by page and marks pages without text", async () => {
    const { prepared } = await run(
      "pdf",
      textPdf(["Page one text", "", "Page three"])
    );
    expect(prepared.pages[0]).toContain("Page one text");
    expect(prepared.pages[1]).toBe("");
    expect(prepared.pages[2]).toContain("Page three");
    expect(prepared.ocrPages).toStrictEqual([2]);
    expect(prepared.extractor).toMatch(/^unpdf@\d/u);
  });

  it("refuses PDFs over the page limit, and broken ones", async () => {
    const tooLong = await refusal(
      run("pdf", textPdf(["1", "2", "3", "4", "5", "6"]))
    );
    expect(tooLong.reason).toBe("too_large");
    expect(tooLong.message).toContain("6 pages");
    const broken = await refusal(run("pdf", "%PDF-1.4\nnot really"));
    expect(broken.reason).toBe("failed");
  });

  it("prepares images: a bounded copy for the model and a thumbnail", async () => {
    const extracted = await run("image", await image(300, 150), "image/png");
    expect(extracted.prepared.image).toStrictEqual({ width: 300, height: 150 });
    expect(extracted.prepared.warnings[0]).toContain("100 pixels");
    const model = await sharp(extracted.modelImage).metadata();
    expect([model.width, model.height, model.format]).toStrictEqual([
      100,
      50,
      "png",
    ]);
    expect(extracted.thumbnail?.byteLength).toBeGreaterThan(0);
  });

  it("refuses images over the pixel limit, and mislabelled ones", async () => {
    const big = await refusal(
      run("image", await image(2100, 2000), "image/png")
    );
    expect(big.reason).toBe("too_large");
    const mislabelled = await refusal(
      run("image", await image(10, 10, "jpeg"), "image/png")
    );
    expect(mislabelled.reason).toBe("unsupported");
  });

  it("stops an extraction that takes too long", async () => {
    const slow = await refusal(
      run("pdf", textPdf(["a"]), "", { timeoutMs: 1, memoryMb: 256 })
    );
    expect(slow.message).toContain("longer than");
  });

  it("reads a CSV as rows, as written: BOM, semicolons, leading zeros and a quoted line break", async () => {
    const { prepared } = await run(
      "table",
      '\uFEFFcódigo;nombre;precio\r\n007;"Pérez; Ana";3,50\r\n008;"dos\nlíneas";12\r\n009;solo\r\n',
      "text/csv"
    );
    expect(prepared).toMatchObject({
      kind: "table",
      pages: [
        "código | nombre | precio\n007 | Pérez; Ana | 3,50\n008 | dos\\nlíneas | 12\n009 | solo",
      ],
      table: { rows: 3, columns: 3, delimiter: ";" },
      warnings: ["Row 4 has a different number of cells than the header (3)."],
    });
  });

  it("reads a TSV with tabs whatever its contents", async () => {
    const { prepared } = await run(
      "table",
      "a\tb,c\n1\t2,3\n",
      "text/tab-separated-values"
    );
    expect(prepared.pages).toStrictEqual(["a | b,c\n1 | 2,3"]);
  });
});

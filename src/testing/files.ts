// Test files built in code: a minimal PDF with one line of text per page (an empty page has no text layer, like a
// scan), and small images.
import sharp from "sharp";

const escapePdf = (text: string) =>
  text.replaceAll(/[\\()]/gu, (char) => `\\${char}`);

/** A valid PDF whose pages each show `pages[i]` (ASCII); an empty string makes a page without text. */
export const textPdf = (pages: readonly string[]): Uint8Array => {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const tree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = pages.map((text) => {
    const stream =
      text === "" ? "" : `BT /F1 12 Tf 72 720 Td (${escapePdf(text)}) Tj ET`;
    const content = add(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
    return add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
};

/** A solid-color image of the given size and format. */
export const image = async (
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp" = "png"
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: "#3366cc" },
    })
      .toFormat(format)
      .toBuffer()
  );

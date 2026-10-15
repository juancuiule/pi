// Delimited text (CSV, TSV) as rows of cells, with no I/O. Values stay exactly as written: no number or date parsing,
// so `007`, long ids and `3,50` reach the model as they are in the file. Row numbers match a spreadsheet's: a quoted
// field may span lines and is still one row.

/** The delimiters a file is tried with, in order of preference on a tie. */
const CANDIDATES = [",", ";", "\t", "|"] as const;

export type Delimiter = (typeof CANDIDATES)[number];

export const DELIMITER_NAMES: Record<Delimiter, string> = {
  ",": "commas",
  ";": "semicolons",
  "\t": "tabs",
  "|": "pipes",
};

export interface Parsed {
  readonly rows: readonly (readonly string[])[];
  /** The file ended inside a quoted field; its last row holds the rest of the file. */
  readonly unterminated: boolean;
}

/**
 * Rows of `text` split by `delimiter`, RFC 4180 style: records end at `\n`, `\r\n` or `\r`; a field that starts with
 * `"` is quoted, may hold delimiters and line breaks, and `""` inside it is one quote. A final line break ends the
 * last record rather than starting an empty one.
 */
export const parseDelimited = (text: string, delimiter: string): Parsed => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (index < text.length) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n" || char === "\r") {
      endRow();
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
    } else {
      field += char;
    }
    index += 1;
  }
  if (quoted || field !== "" || row.length > 0) {
    endRow();
  }
  return { rows, unterminated: quoted };
};

/** How much of a file the delimiter is guessed from. */
const SAMPLE = 64 * 1024;

/** How many sampled rows have the most common column count, when that count is more than one. */
const consistency = (rows: readonly (readonly string[])[]) => {
  const counts = new Map<number, number>();
  for (const row of rows) {
    counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  }
  let best = 0;
  for (const [columns, times] of counts) {
    if (columns > 1 && times > best) {
      best = times;
    }
  }
  return best;
};

/**
 * The delimiter of a CSV file: the candidate that splits the most sampled rows into the same number (more than one)
 * of columns. Spreadsheets in many locales save "CSV" with semicolons. Commas when nothing splits.
 */
export const detectDelimiter = (text: string): Delimiter => {
  const sample = text.slice(0, SAMPLE);
  // A sample cut mid-file ends in a partial row; it is left out.
  const cut = sample.length < text.length;
  let best: { delimiter: Delimiter; score: number } = {
    delimiter: ",",
    score: 0,
  };
  for (const delimiter of CANDIDATES) {
    const { rows } = parseDelimited(sample, delimiter);
    const score = consistency(cut ? rows.slice(0, -1) : rows);
    if (score > best.score) {
      best = { delimiter, score };
    }
  }
  return best.delimiter;
};

/** A row as one line for the model: cells between ` | `, with pipes and line breaks inside cells escaped. */
export const renderRow = (cells: readonly string[]): string =>
  cells
    .map((cell) =>
      cell
        .replaceAll("\\", "\\\\")
        .replaceAll("|", "\\|")
        .replaceAll(/\r\n?|\n/gu, "\\n")
    )
    .join(" | ");

/** Rows whose column count differs from the first row's, ignoring empty lines. */
export const raggedRows = (rows: readonly (readonly string[])[]): number[] => {
  const columns = rows[0]?.length ?? 0;
  return rows.flatMap((row, index) =>
    row.length !== columns && !(row.length === 1 && row[0] === "")
      ? [index + 1]
      : []
  );
};

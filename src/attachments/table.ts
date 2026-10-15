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
  // Whether the current field began, even if it is still empty: `""` is a field.
  let started = false;
  let quoted = false;
  let index = 0;
  const endField = () => {
    row.push(field);
    field = "";
    started = false;
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
      started = true;
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
  if (quoted || started || field !== "" || row.length > 0) {
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

/** The share of a row's later fields that start with a space: high for a comma in prose ("Albany, NY"). */
const proseLike = (rows: readonly (readonly string[])[]) => {
  let later = 0;
  let spaced = 0;
  for (const row of rows) {
    for (const cell of row.slice(1)) {
      later += 1;
      if (cell.startsWith(" ")) {
        spaced += 1;
      }
    }
  }
  return later === 0 ? 0 : spaced / later;
};

export interface Detected {
  readonly delimiter: Delimiter;
  /** Other delimiters that split the sample just as well: the choice is a guess. */
  readonly alternatives: readonly Delimiter[];
}

/**
 * The delimiter of a CSV file: the candidate that splits the most sampled rows into the same number (more than one)
 * of columns. Spreadsheets in many locales save "CSV" with semicolons. On a tie, a candidate whose later fields
 * mostly start with a space loses (that is a comma in text, not between columns); a tie that remains is reported in
 * `alternatives`. Commas when nothing splits.
 */
export const detectDelimiter = (text: string): Detected => {
  const sample = text.slice(0, SAMPLE);
  // A sample cut mid-file ends in a partial row; it is left out.
  const cut = sample.length < text.length;
  const scored = CANDIDATES.map((delimiter) => {
    const { rows } = parseDelimited(sample, delimiter);
    const sampled = cut ? rows.slice(0, -1) : rows;
    return {
      delimiter,
      score: consistency(sampled),
      prose: proseLike(sampled),
    };
  });
  const top = Math.max(...scored.map((each) => each.score));
  if (top === 0) {
    return { delimiter: ",", alternatives: [] };
  }
  const tied = scored.filter((each) => each.score === top);
  const cleanest = Math.min(...tied.map((each) => each.prose));
  const [chosen, ...others] = tied.filter((each) => each.prose === cleanest);
  return {
    delimiter: chosen?.delimiter ?? ",",
    alternatives: others.map((each) => each.delimiter),
  };
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

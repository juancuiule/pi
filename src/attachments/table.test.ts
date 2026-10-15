import { describe, expect, it } from "vitest";

import {
  detectDelimiter,
  parseDelimited,
  raggedRows,
  renderRow,
} from "./table.ts";

describe(parseDelimited, () => {
  it("splits quoted fields, escaped quotes and line breaks inside a value", () => {
    expect(
      parseDelimited(
        'id,name,note\r\n007,"Pérez, Ana","says ""hi""\nthen leaves"\r\n008,Luis,\n',
        ","
      )
    ).toStrictEqual({
      rows: [
        ["id", "name", "note"],
        ["007", "Pérez, Ana", 'says "hi"\nthen leaves'],
        ["008", "Luis", ""],
      ],
      unterminated: false,
    });
  });

  it("keeps empty lines as rows, and reports a quote that never closes", () => {
    expect(parseDelimited('a\n\nb\n"open', ",")).toStrictEqual({
      rows: [["a"], [""], ["b"], ["open"]],
      unterminated: true,
    });
  });
});

describe(detectDelimiter, () => {
  it("finds the delimiter that splits rows consistently", () => {
    expect([
      detectDelimiter("a,b,c\n1,2,3\n4,5,6"),
      // A spreadsheet in a comma-decimal locale: the commas are in the numbers.
      detectDelimiter("producto;precio\nA;3,50\nB;12,00"),
      detectDelimiter("a\tb\n1\t2"),
      detectDelimiter("just one column\nper row"),
    ]).toStrictEqual([",", ";", "\t", ","]);
  });
});

describe(renderRow, () => {
  it("keeps one row on one line, with pipes and line breaks escaped", () => {
    expect(renderRow(["a|b", "x\ny", "c:\\d", ""])).toBe(
      "a\\|b | x\\ny | c:\\\\d | "
    );
  });
});

describe(raggedRows, () => {
  it("lists rows whose cell count differs from the header, ignoring empty lines", () => {
    expect(
      raggedRows([["a", "b"], ["1", "2"], [""], ["3"], ["4", "5", "6"]])
    ).toStrictEqual([4, 5]);
  });
});

// The pure parts of the Nextcloud connector: DAV multistatus parsing, iCalendar and vCard in and out, paths.
import { describe, expect, it } from "vitest";

import { buildEvent, icalTime, parseEvents } from "./calendar.ts";
import { pathSegments, permissionBits } from "./client.ts";
import { buildContact, parseContacts } from "./contacts.ts";
import { parseComponents } from "./lines.ts";
import { multistatus } from "./xml.ts";

describe(multistatus, () => {
  it("reads hrefs and the 200 propstat whatever the prefixes", () => {
    const [first, second] = multistatus(`<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:"><D:response><D:href>/a%20b/</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
      <D:propstat><D:prop><D:getcontentlength/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
      </D:response><d:response xmlns:d="DAV:"><d:href>/x.txt</d:href><d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></D:multistatus>`);
    expect(first?.href).toBe("/a%20b/");
    expect(first?.props.children.map((c) => c.name)).toStrictEqual([
      "resourcetype",
    ]);
    expect(second?.props.children[0]?.text).toBe("5");
  });
});

describe("iCalendar", () => {
  it("reads events, unfolding lines and unescaping text", () => {
    const [event] = parseEvents(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Team\\, weekly\r\nDESCRIPTION:line one\\nline\r\n  two\r\nDTSTART;TZID=Europe/Berlin:20261103T100000\r\nDTEND;TZID=Europe/Berlin:20261103T110000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    );
    expect(event).toMatchObject({
      uid: "1",
      summary: "Team, weekly",
      description: "line one\nline two",
      start: "2026-11-03T10:00:00 [Europe/Berlin]",
      recurring: true,
      allDay: false,
    });
  });

  it("speaks of an all-day event's last day, not iCalendar's exclusive end", () => {
    const built = buildEvent({
      summary: "Trip",
      start: "2026-11-03",
      end: "2026-11-04",
    });
    if ("error" in built) {
      throw new Error(built.error);
    }
    expect(built.ics).toContain("DTSTART;VALUE=DATE:20261103");
    expect(built.ics).toContain("DTEND;VALUE=DATE:20261105");
    expect(parseEvents(built.ics)[0]).toMatchObject({
      start: "2026-11-03",
      end: "2026-11-04",
      allDay: true,
    });
  });

  it("needs an offset on a date-time, and an end after the start", () => {
    expect(icalTime("2026-11-03T10:00", "start")).toHaveProperty("error");
    expect(icalTime("2026-11-03T10:00:00-03:00", "start")).toMatchObject({
      value: "20261103T130000Z",
    });
    expect(
      buildEvent({
        summary: "x",
        start: "2026-11-03T10:00:00Z",
        end: "2026-11-03T09:00:00Z",
      })
    ).toStrictEqual({ error: "end is before start." });
  });

  it("folds long lines at 75 octets without splitting a character", () => {
    const built = buildEvent({
      summary: "ñ".repeat(80),
      start: "2026-11-03T10:00:00Z",
      end: "2026-11-03T11:00:00Z",
    });
    if ("error" in built) {
      throw new Error(built.error);
    }
    for (const line of built.ics.split("\r\n")) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
    expect(parseEvents(built.ics)[0]?.summary).toBe("ñ".repeat(80));
  });
});

describe("vCard", () => {
  it("round-trips a new contact", () => {
    const { vcf } = buildContact({
      name: "Ada Lovelace",
      emails: ["ada@example.com"],
      phones: ["+44 1"],
      organization: "Analytical; Engines",
    });
    expect(parseComponents(vcf)[0]?.name).toBe("VCARD");
    expect(parseContacts(vcf)[0]).toMatchObject({
      name: "Ada Lovelace",
      emails: ["ada@example.com"],
      phones: ["+44 1"],
      organization: "Analytical; Engines",
    });
  });

  it("names a contact from N without FN, and keeps meaningful types", () => {
    const [contact] = parseContacts(
      "BEGIN:VCARD\nVERSION:3.0\nN:Hopper;Grace;;Rear Adm.;\nitem1.EMAIL;TYPE=INTERNET,WORK:g@navy.mil\nEND:VCARD\n"
    );
    expect(contact?.name).toBe("Rear Adm. Grace Hopper");
    expect(contact?.emails).toStrictEqual(["g@navy.mil (work)"]);
  });
});

describe("paths", () => {
  it("refuses segments that climb out of the files root", () => {
    expect(pathSegments("/Documents//a.md")).toStrictEqual([
      "Documents",
      "a.md",
    ]);
    expect(() => pathSegments("/a/../../etc")).toThrow("Not a usable path");
  });

  it("maps read and edit to OCS permission bits", () => {
    expect(permissionBits("read", true)).toBe(1);
    expect(permissionBits("edit", false)).toBe(3);
    expect(permissionBits("edit", true)).toBe(15);
  });
});

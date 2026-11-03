// Contacts in and out of vCard for the Nextcloud tools: the fields a person asks about (name, emails, phones,
// organization, title, birthday, note), and vCard 3.0 for new contacts, which every CardDAV client reads.
import { randomUUID } from "node:crypto";

import {
  escapeText,
  parseComponents,
  serialize,
  textValue,
  unescapeText,
} from "./lines.ts";
import type { Component } from "./lines.ts";

export interface Contact {
  readonly uid: string;
  readonly name: string;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly organization?: string;
  readonly title?: string;
  readonly birthday?: string;
  readonly note?: string;
}

const values = (card: Component, name: string): string[] =>
  card.properties
    .filter((p) => p.name === name)
    .map((p) => {
      const value = unescapeText(p.value).trim();
      // `internet` and `pref` say nothing a person reads; `home`, `work`, `cell` do.
      const type = (p.params.TYPE ?? "")
        .toLowerCase()
        .split(",")
        .filter((t) => t !== "" && t !== "internet" && t !== "pref")
        .join(", ");
      return type === "" || value === "" ? value : `${value} (${type})`;
    })
    .filter((value) => value !== "");

const nameOf = (card: Component): string => {
  const full = textValue(card, "FN");
  if (full !== undefined) {
    return full;
  }
  // N is family;given;additional;prefix;suffix.
  const parts = (card.properties.find((p) => p.name === "N")?.value ?? "")
    .split(";")
    .map((part) => unescapeText(part).trim());
  const name = [parts[3], parts[1], parts[2], parts[0], parts[4]]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return name === "" ? "(no name)" : name;
};

// ORG is the organization and its units, separated by unescaped semicolons.
const organizationOf = (card: Component): string | undefined => {
  const raw = card.properties.find((p) => p.name === "ORG")?.value ?? "";
  const units = raw
    .split(/(?<!\\);/u)
    .map((unit) => unescapeText(unit).trim())
    .filter((unit) => unit !== "");
  return units.length === 0 ? undefined : units.join(", ");
};

/** The VCARDs of one address object. */
export const parseContacts = (vcf: string): Contact[] =>
  parseComponents(vcf)
    .filter((component) => component.name === "VCARD")
    .map((card) => {
      const organization = organizationOf(card);
      const title = textValue(card, "TITLE");
      const birthday = textValue(card, "BDAY");
      const note = textValue(card, "NOTE");
      return {
        uid: textValue(card, "UID") ?? "",
        name: nameOf(card),
        emails: values(card, "EMAIL"),
        phones: values(card, "TEL"),
        ...(organization === undefined ? {} : { organization }),
        ...(title === undefined ? {} : { title }),
        ...(birthday === undefined ? {} : { birthday }),
        ...(note === undefined ? {} : { note }),
      };
    });

export interface NewContact {
  readonly name: string;
  readonly emails?: readonly string[] | undefined;
  readonly phones?: readonly string[] | undefined;
  readonly organization?: string | undefined;
  readonly title?: string | undefined;
  readonly note?: string | undefined;
}

/** `NAME:value` when there is a value. */
const optional = (name: string, value: string | undefined) =>
  value === undefined || value.trim() === ""
    ? []
    : [`${name}:${escapeText(value.trim())}`];

/** A vCard 3.0 for a new contact. `N` is derived from the name's last word as the family name. */
export const buildContact = (
  input: NewContact
): { readonly uid: string; readonly vcf: string } => {
  const uid = randomUUID();
  const words = input.name.trim().split(/\s+/u);
  const family = words.length > 1 ? (words.at(-1) ?? "") : "";
  const given =
    words.length > 1 ? words.slice(0, -1).join(" ") : input.name.trim();
  return {
    uid,
    vcf: serialize([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "PRODID:-//effect-pi//Nextcloud connector//EN",
      `UID:${uid}`,
      `FN:${escapeText(input.name.trim())}`,
      `N:${escapeText(family)};${escapeText(given)};;;`,
      ...(input.emails ?? []).flatMap((email) =>
        optional("EMAIL;TYPE=INTERNET", email)
      ),
      ...(input.phones ?? []).flatMap((phone) => optional("TEL", phone)),
      ...optional("ORG", input.organization),
      ...optional("TITLE", input.title),
      ...optional("NOTE", input.note),
      "END:VCARD",
    ]),
  };
};

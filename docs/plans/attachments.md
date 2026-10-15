# Attachments

A person drops files into the composer; each one is uploaded, checked and prepared on the server at once, and the next message carries the ready ones to the model. Decided in a grilling session (2026-10-14); the requirements are section 2 of the platform research.

## Lifecycle

```text
upload (streamed to a temp file, size-limited) → store the original privately → validate (extension, reported type,
signature) → extract in a worker (time and memory limits) → ready | partial | needs_ocr
                                                           (unsupported / failed: the upload is refused, nothing kept)
→ attach to a message (sent) → kept with its conversation
```

- **Scope.** An upload belongs to one conversation, or, before the conversation exists, to nobody yet ("staged"): `create` claims staged ids atomically, `send` only takes ids uploaded to that conversation. Ids are random (`att_` + 128 bits), so a staged id cannot be guessed; an id outside its scope is "not found". There is no person identity yet (the server has no auth); scoping by conversation is the guarantee for now.
- **Immutable.** One upload, one extraction: the original's SHA-256, the extractor and its version, warnings, and the prepared text or image are recorded once. A failed upload is removed and uploaded again; nothing is reprocessed.
- **Retention.** Unsent uploads (staged or not) expire 24h after upload (the attachment sweep); removing one in the composer deletes it at once. Sent attachments stay with their conversation through Pause and Archive.
- **Storage.** `AttachmentStore` keeps bytes in a `BlobStore` (a local directory, `ATTACHMENTS_DIR`; S3 could be another one) and metadata in its own table in the `EFFECT_PI_DB` SQLite file.

## Formats (v1)

| Kind | Accepted | Prepared as |
| --- | --- | --- |
| text | `.txt`, `.md`, `.markdown` | Decoded text (UTF-8, UTF-16 with BOM, else Windows-1252 if it has no control bytes) |
| html | `.html`, `.htm` | Readable text from `htmlparser2` (headings, lists, tables, link targets); no scripts, styles or fetching; the source stays readable with `view: "source"` |
| pdf | `.pdf` with a `%PDF-` signature | Text per page (`unpdf`); pages without text are listed as needing OCR |
| table | `.csv`, `.tsv` | One line per row, cells between `\|` exactly as written (no number or date parsing); quoted fields may hold delimiters and line breaks; a CSV's delimiter is detected (commas, semicolons, tabs or pipes), a TSV's is a tab. Row 1 is the header, and every read from further down repeats it |
| image | PNG, JPEG, WebP by signature | Validated and bounded (`sharp`); downscaled to 1568px for the model, plus a thumbnail |

Statuses: `ready`; `partial` (a PDF with some pages that need OCR); `needs_ocr` (no page has text). No OCR runs in v1. Anything else is refused as unsupported.

## Reaching the model

- The message is the typed text (the only part `/skill:` reads), then one `<attachment …>` block per file. Documents are inline, whole pages at a time, up to `ATTACHMENT_INLINE_CHARS` per message; a block that does not fit says which pages or lines it holds and how to read the rest. Images follow as image content when the model takes images; otherwise the block says the image was not sent.
- The `attachments` extension (always on, locked) has `read_attachment` (any range, at most `ATTACHMENT_READ_CHARS` per call, with where it is in the whole file and what to read next) and `search_attachment` (lines matching every term, with page and line). Both run on the host, so they work at every Level, and only read the conversation's own sent attachments.
- Conversations with a shell or desktop also get each sent original at `/workspace/.attachments/<id>/<name>`.
- Traces replace attachment text (message blocks and the tools' results) with its size, unless `TRACE_ATTACHMENT_TEXT=true`.

## Limits (`.env.schema`)

25 MB per file, 10 files per message, 200 MB of unsent uploads in all, 300 PDF pages, 40 megapixels per image, 30s and 512 MB per extraction, 2 extractions at once.

## Later

OCR as its own action (a server-side OCR worker storing `source: "ocr"` text; page images for vision models as a fallback); XLSX (sheets as tables, cached formula values without recalculation, zip size checks); a host-side `query_attachment` (read-only SQL over a table in an in-memory SQLite) for totals and groupings at Level none; JSON; DOCX/PPTX; previews; semantic search; conversation deletion and its derivatives.

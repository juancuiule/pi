# Attachments are checked and prepared once, at upload, in a worker

An upload is streamed to a size-limited temporary file, checked (extension, reported type and signature must agree for any kind we prepare), and prepared in a worker thread with a time and memory limit, before the upload request answers. Parsing PDFs and images is where untrusted bytes are most dangerous, so it never runs on the server's main thread, and a file that fails is refused with nothing kept, so there is never a half-prepared attachment to reason about. Decided in a grilling session on 2026-10-14.

## Decisions

- **Immutable.** One upload, one extraction: the original's SHA-256, the extractor and its version, warnings and the prepared text or image are recorded once. Nothing is reprocessed; a bad upload is removed and uploaded again.
- **Scope by capability.** An upload belongs to one conversation, or is staged until `create` claims it. Ids are random (128 bits), and an id outside its scope is "not found".
- **Prepared, not guessed.** Text is decoded, HTML reduced to text with htmlparser2 (nothing runs or is fetched), tables kept one line per row with cells as written (no number or date parsing), so line numbers match the file and the agent computes totals with the shell instead of estimating. Any other file is kept as a `file`, read as text when it decodes as text.
- **The browser never opens an upload.** PDF pages are drawn to WebP by the server; originals download with `nosniff` and a sandbox CSP.
- **No OCR yet.** PDF pages without text are reported as needing OCR rather than silently empty.

## Considered options

- Preparing lazily, on first read: rejected because a broken file would surface in the middle of a Run instead of in the composer, where the person can fix it.

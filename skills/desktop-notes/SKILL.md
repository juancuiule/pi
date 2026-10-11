---
name: desktop-notes
description: Write and save a text note with the Mousepad editor on the XFCE desktop, and check that it was saved. Use when the user asks to write, type or save a note, list or text file through the graphical desktop.
compatibility: Needs a desktop sandbox (desktop_* tools and bash).
---

# Notes with Mousepad on the desktop

The user wants the note typed and saved in a desktop editor. Never create or change the file another way (`write`, `edit`, or shell redirection): if the desktop steps fail, say what failed instead.

Paths in this skill are relative to its folder; `<skill folder>` below is the full path the skill tool gave you.

## 1. Open Mousepad on the file

Start Mousepad from the shell with the file the user wants, always under `/workspace/` (use `/workspace/note.txt` if they gave no name):

```bash
setsid mousepad /workspace/<name> >/dev/null 2>&1 &
```

Do not use the Applications menu or the Application Finder: their suggestion lists cover their buttons and lead to the wrong window.

Take a screenshot. You should see a Mousepad window titled `/workspace/<name> - Mousepad` with an empty text area. If it is not there yet, wait a moment and take another one.

## 2. Type the note

Click inside the text area once so it has focus. Type each line with `desktop_type`, and press `Return` with `desktop_key` between lines. The title now starts with `*`, which means unsaved changes.

## 3. Save

Press `ctrl+s`. Mousepad already knows the file name, so no dialog opens; the `*` disappears from the title. Take a screenshot to see it.

## 4. Check

```bash
<skill folder>/scripts/check-note.sh /workspace/<name>
```

It prints the file and `ok`, or what is wrong and how to fix it. Fix it in Mousepad and run it again until it prints `ok`. Then answer with the path and the file's contents as the check printed them.

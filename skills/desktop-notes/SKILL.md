---
name: desktop-notes
description: Write and save a text note with the Mousepad editor on the XFCE desktop, and check that it was saved. Use when the user asks to write, type or save a note, list or text file through the graphical desktop.
compatibility: Needs a desktop sandbox (desktop_* tools and bash).
---

# Notes with Mousepad on the desktop

The desktop is XFCE at 1280×800. Take a screenshot before each step and after it, and only move on once the screenshot shows the step worked. Coordinates come from the latest screenshot, never from these instructions.

## Open Mousepad

1. Press `alt+F2` with `desktop_key`. The **Application Finder** dialog opens in the middle of the screen with a text field focused.
2. Type `mousepad` with `desktop_type`.
3. Take a screenshot. Typing and launching too quickly can leave the dialog open with the text in it: if it is still there, click its **Launch** button (bottom right of the dialog) instead of pressing Return again.
4. Wait for a screenshot that shows an "Untitled" Mousepad window. It can take a few seconds the first time.

## Write and save

1. Click inside the Mousepad text area so it has focus, then type the note with `desktop_type`. For line breaks, type each line separately and press `Return` between them.
2. Press `ctrl+s`. A **Save As** dialog opens with the **Name** field focused.
3. Type the full path, always under `/workspace/` so the file can be checked from the shell, for example `/workspace/note.txt`, then press `Return`.
4. The window title changes from "Untitled" to the file name. If a dialog asks to replace an existing file, click **Replace** only if the user asked to overwrite it.

## Check

Run `cat /workspace/<name>` with `bash` and compare it with what the user asked for. Report the path and the file's contents. If they differ, fix the text in Mousepad and save again rather than writing the file from the shell: the user asked for the desktop to be used.

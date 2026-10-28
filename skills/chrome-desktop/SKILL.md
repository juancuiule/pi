---
name: chrome-desktop
description: Open, drive and capture web pages with Google Chrome in the desktop sandbox. Use when the person asks to open a site or a local dev server in Chrome, look at or test a web page, click through a web app, or send them a screenshot of a page, and before launching google-chrome from bash at all.
compatibility: Needs a desktop sandbox with the Google Chrome software (`google-chrome` on PATH).
---

# Chrome on the desktop

The sandbox runs as root in a container with no person at the keyboard. `google-chrome` is a wrapper that already adds the flags this needs (`--no-sandbox`, `--no-first-run`, `--no-default-browser-check`, `--password-store=basic`, `--disable-dev-shm-usage`, `--start-maximized`), and policies turn off its sign-in, sync, default-browser, password, translate and permission prompts. The panel's browser button and `xdg-open` go through the same wrapper.

## 1. Pick the mode

- **Only need the page's text or HTML**: no browser. `curl -sL <url>`, or `google-chrome --headless=new --dump-dom <url> 2>/dev/null` when the page builds its content with JavaScript.
- **A picture of one page for the person**: a headless screenshot (step 3). No window, no dialogs, one call.
- **The person wants to watch, or the task needs clicks, typing, logins or several pages**: visible Chrome on the desktop (steps 2 and 4).

Run `command -v google-chrome` first. When it is missing, Chrome is not part of this workspace: say so, and that the person can add Google Chrome under Software in the console. `upgrade_workspace` cannot add it.

## 2. Launch it visibly

From `bash`, in the background, then wait for the window and focus it:

```sh
nohup google-chrome "http://localhost:3001/" >/tmp/chrome.log 2>&1 &
for i in $(seq 40); do xdotool search --onlyvisible --class google-chrome >/dev/null 2>&1 && break; sleep 0.5; done
xdotool search --onlyvisible --class google-chrome | tail -1 | xargs -r xdotool windowactivate --sync
```

Then `desktop_screenshot`.

- When Chrome is already running, a second `google-chrome <url>` opens another window. Navigate the open one instead (step 4).
- To start over: `pkill -x chrome`. Never `pkill -f chrome`: it also matches your own bash command and kills it.
- No window after the loop: `tail /tmp/chrome.log`, fix what it says, relaunch.

## 3. Screenshot a page without the desktop

```sh
curl -s -o /dev/null -w '%{http_code}\n' --max-time 120 http://localhost:3001/   # wait for 200 first
google-chrome --headless=new --hide-scrollbars --window-size=1280,800 \
  --virtual-time-budget=5000 --screenshot=/workspace/<name>.png http://localhost:3001/ 2>&1 | tail -1
```

- A dev server compiles on the first request (Next.js can take more than a minute): get a 200 from `curl` before the capture, or the picture is a loading screen.
- `--window-size=1280,2400` for a longer page; `--virtual-time-budget` lets scripts and animations settle.
- Chrome logs many harmless dbus and GL errors; `tail -1` keeps only its last line, "… bytes written to file …" or the load error.
- Check the file with `read` before you claim it shows the page.

## 4. Drive it with the keyboard

Keys go to the focused window and do not depend on reading pixel coordinates. Prefer `desktop_key` over clicking the browser's own buttons:

| Goal | Keys |
| --- | --- |
| Go to a URL | `ctrl+l`, then `desktop_type` the URL, then `Return` |
| Reload / hard reload | `F5` / `ctrl+shift+r` |
| Back / forward | `alt+Left` / `alt+Right` |
| New tab / close tab / next tab | `ctrl+t` / `ctrl+w` / `ctrl+Tab` |
| Find on page | `ctrl+f`, type, `Return`, `Escape` |
| Scroll a screen / top / bottom | `Page_Down` / `Home` / `End` (click an empty part of the page first) |
| Zoom out to see more | `ctrl+minus`, back with `ctrl+0` |
| Move between form fields | `Tab`, `shift+Tab`; `Return` submits |
| Dismiss a bubble or popup | `Escape` |

Click only inside the page, on something you saw in the latest screenshot. After every action that changes the page, take a `desktop_screenshot` before the next one.

## 5. When something is in the way

Look at the screenshot, name what is on top, and find it in `references/dialogs.md`. Cookie banners and sign-in walls belong to the site, so no policy removes them: that file says what to do. The same dialog twice means the launch is wrong, not that you clicked badly: fix the command instead of clicking again.

## 6. Hand it over

- Tell the person what is on screen and where: the desktop panel, or the screenshot's path in `/workspace`.
- Leave background servers and Chrome running when the person wants to look, and say how to stop them.

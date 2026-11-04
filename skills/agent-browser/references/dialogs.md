# What can still get in the way

The image's `google-chrome` wrapper and managed policies prevent most of these; the rest belong to the site. Look at the page, name what is on top, and find it here. Keys below are `agent-browser press <key>`, or `desktop_key` on the desktop.

| You see | Do |
| --- | --- |
| "Additional Terms of Service" with Accept/Cancel | Chrome was started without the wrapper (`/usr/bin/google-chrome-stable` called directly). Do not accept on the person's behalf: `pkill -x chrome` and start `google-chrome`. |
| "Running as root without --no-sandbox is not supported" | Same cause: start `google-chrome`, not the binary under `/usr/bin` or `/opt`. |
| "Restore pages?" / "Chrome didn't shut down correctly" | `Escape` |
| "Make Chrome your own" / "Sign in to Chrome" / sync offers | "No thanks" or `Escape`; never sign in to Chrome itself |
| "Save password?" / autofill offers | `Escape` |
| A site asks for notifications, location or the camera | `Escape` (blocks) |
| A site's cookie banner | Choose the reject or "only necessary" button; ask the person when the page offers only accept |
| A site's own sign-in wall | Stop and ask the person; do not type credentials you were not given for that site |
| "Aw, Snap!" | Reload; when it repeats, close other tabs or `pkill -x chrome` and start again |
| Text in Chinese, Japanese or Korean shows as empty boxes | No CJK fonts are installed; say so instead of reading the page |

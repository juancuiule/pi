# What can still get in the way

Policies and the wrapper's flags prevent most of these; the rest belong to the site.

| You see | Do |
| --- | --- |
| "Additional Terms of Service" with Accept/Cancel | Chrome was started without `--no-first-run` (`/usr/bin/google-chrome-stable` called directly). Do not accept on the person's behalf: `pkill -x chrome` and relaunch with `google-chrome`. |
| "Running as root without --no-sandbox is not supported" in the log, no window | Same cause: launch `google-chrome`, not the binary under `/usr/bin` or `/opt`. |
| "Restore pages?" / "Chrome didn't shut down correctly" | `Escape` |
| "Make Chrome your own" / "Sign in to Chrome" / sync offers | "No thanks" or `Escape`; never sign in to Chrome itself |
| "Save password?" / autofill offers | `Escape` |
| A site asks for notifications, location or the camera | `Escape` (blocks) |
| A site's cookie banner | Choose the reject or "only necessary" button; ask the person when the page offers only accept |
| A site's own sign-in wall | Stop and ask the person; do not type credentials you were not given for that site |
| "Aw, Snap!" | `F5`; when it repeats, close other tabs or `pkill -x chrome` and relaunch |
| The desktop with no Chrome window | It failed to start: `tail /tmp/chrome.log`, fix, relaunch |
| Text in Chinese, Japanese or Korean shows as empty boxes | No CJK fonts are installed; say so instead of reading the page |

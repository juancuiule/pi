// Leaving the console for /login. A lost session (any call answering Unauthorized), the console gate finding no
// User, and Sign out all go through `leaveConsole`; only the first call until the next sign-in reaches the handler
// the gate installs, so a burst of failing polls redirects once and Sign out's plain /login is not overridden.

type Leave = (to: string) => void;

let handler: Leave | undefined;
let left = false;

/** Installs what leaving does (clear the caches, navigate); the returned function uninstalls it. */
export const onLeaveConsole = (leave: Leave): (() => void) => {
  handler = leave;
  return () => {
    if (handler === leave) {
      handler = undefined;
    }
  };
};

export const leaveConsole = (to: string): void => {
  if (left || handler === undefined) {
    return;
  }
  left = true;
  handler(to);
};

/** A User is signed in again: the next leave goes through. */
export const signedIn = (): void => {
  left = false;
};

/** Where a lost session goes: /login, coming back to `current` (a path with its query) afterwards. */
export const loginPath = (current: string): string =>
  current === "/" || current.startsWith("/login")
    ? "/login"
    : `/login?next=${encodeURIComponent(current)}`;

/** The session is gone: back to /login, then to the page the person was on. */
export const sessionLost = (): void => {
  leaveConsole(
    loginPath(`${window.location.pathname}${window.location.search}`)
  );
};

const BASE = "http://console.invalid";

/**
 * Where `next` may send the person after signing in: a path on this origin, else the console's home. Parsed as a
 * URL rather than matched by prefix, so `//host`, `/\host` and paths with tabs or newlines cannot leave the origin.
 */
export const safeNext = (next: string | null | undefined): string => {
  if (next === null || next === undefined || !next.startsWith("/")) {
    return "/";
  }
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return "/";
  }
  return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : "/";
};

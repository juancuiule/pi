"use client";

// Settings → Connections: the third-party accounts the agent works in for this User (Nextcloud first). Connecting
// opens the service's own login in a new tab (Login Flow v2) while this page polls, or takes a login and app
// password. The secret goes to the server and never comes back; the agent never sees it.
import { Collapsible } from "@base-ui/react/collapsible";
import type { ConnectorStatus } from "effect-pi/api";
import { ChevronRight, ExternalLink, Link2, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { apiError } from "@/lib/api";
import {
  pollConnectorLogin,
  startConnectorLogin,
  useConnect,
  useConnectors,
  useDisconnect,
  useRefreshConnectors,
} from "@/lib/queries";

const POLL_MS = 2000;

const inputClass =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring h-7 min-w-0 flex-1 rounded-md border px-2 text-base outline-none focus-visible:ring-3 md:text-xs";

/** Polls a started browser login until it connects, fails or is cancelled. */
const useBrowserLogin = (id: string) => {
  const refresh = useRefreshConnectors();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  const handleCancel = () => {
    cancelled.current = true;
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    setWaiting(false);
  };
  useEffect(
    () => () => {
      cancelled.current = true;
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const poll = (expiresAt: number) => {
    timer.current = setTimeout(async () => {
      if (cancelled.current) {
        return;
      }
      if (Date.now() > expiresAt) {
        setWaiting(false);
        setError("The login expired. Start it again.");
        return;
      }
      try {
        const outcome = await pollConnectorLogin(id);
        if (cancelled.current) {
          return;
        }
        if (outcome.status === "connected") {
          setWaiting(false);
          await refresh();
          return;
        }
        poll(expiresAt);
      } catch (pollError) {
        setWaiting(false);
        setError(apiError(pollError));
      }
    }, POLL_MS);
  };

  const start = async () => {
    // Opened before any await, so the popup blocker sees the click; detached from this page before it navigates.
    const tab = window.open("about:blank", "_blank");
    if (tab !== null) {
      tab.opener = null;
    }
    setError(undefined);
    cancelled.current = false;
    try {
      const { loginUrl, expiresAt } = await startConnectorLogin(id);
      if (tab === null) {
        window.open(loginUrl, "_blank", "noopener");
      } else {
        tab.location.href = loginUrl;
      }
      setWaiting(true);
      poll(expiresAt);
    } catch (startError) {
      tab?.close();
      setError(apiError(startError));
    }
  };

  return { waiting, error, start, handleCancel };
};

const ConnectorCard = ({ connector }: { connector: ConnectorStatus }) => {
  const connect = useConnect();
  const disconnect = useDisconnect();
  const login = useBrowserLogin(connector.id);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const { connection } = connector;
  const shownError = error ?? login.error;

  return (
    <div className="border-border flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Link2 aria-hidden className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{connector.title}</span>
        <a
          href={connector.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground min-w-0 truncate font-mono text-xs"
        >
          {connector.url}
        </a>
      </div>
      {connection === undefined ? null : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs">
            {connection.unreadable ? (
              <span className="text-destructive">
                This connection can no longer be read on this server (its key
                changed). Connect again.
              </span>
            ) : (
              <>
                Connected as{" "}
                <span className="font-medium">
                  {connection.account.displayName}
                </span>{" "}
                <span className="text-muted-foreground font-mono">
                  ({connection.account.login})
                </span>
              </>
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(connector.id, {
                onError: (mutationError) => setError(apiError(mutationError)),
              })
            }
          >
            <Unlink aria-hidden className="size-3.5" />
            Disconnect
          </Button>
        </div>
      )}
      {connection === undefined || connection.unreadable ? (
        <>
          <p className="text-muted-foreground text-xs">
            The agent works in your {connector.title} account: reading runs
            right away, and anything that changes it waits for your approval
            when approvals are on.
          </p>
          {connector.loginFlow ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={login.waiting}
                onClick={() => {
                  setError(undefined);
                  void login.start();
                }}
              >
                <ExternalLink aria-hidden className="size-3.5" />
                Connect with {connector.title}
              </Button>
              {login.waiting ? (
                <>
                  <output className="text-muted-foreground text-xs">
                    Waiting for you to grant access in the {connector.title}{" "}
                    tab…
                  </output>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={login.handleCancel}
                  >
                    Cancel
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          <Collapsible.Root defaultOpen={!connector.loginFlow}>
            <Collapsible.Trigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs">
              <ChevronRight
                aria-hidden
                className="size-3 transition-transform group-data-[panel-open]:rotate-90"
              />
              Use an app password instead
            </Collapsible.Trigger>
            <Collapsible.Panel>
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError(undefined);
                  connect.mutate(
                    { id: connector.id, login: name.trim(), password },
                    {
                      onSuccess: () => {
                        setName("");
                        setPassword("");
                      },
                      onError: (mutationError) =>
                        setError(apiError(mutationError)),
                    }
                  );
                }}
              >
                <input
                  type="text"
                  autoComplete="username"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Login"
                  aria-label={`${connector.title} login`}
                  className={inputClass}
                />
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="App password"
                  aria-label={`${connector.title} app password`}
                  className={inputClass}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={
                    connect.isPending || name.trim() === "" || password === ""
                  }
                >
                  Connect
                </Button>
              </form>
              <p className="text-muted-foreground mt-1 text-xs">
                Create one in {connector.title} under Settings → Security → App
                passwords. A regular password is exchanged for an app password
                and not kept.
              </p>
            </Collapsible.Panel>
          </Collapsible.Root>
        </>
      ) : null}
      {shownError === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {shownError}
        </p>
      )}
    </div>
  );
};

/** Hidden on a server without connectors. */
export const ConnectionsSection = () => {
  const { data: connectors } = useConnectors();
  if (connectors === undefined || connectors.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="connections-heading"
      className="flex flex-col gap-2"
    >
      <h2
        id="connections-heading"
        className="font-heading text-sm font-semibold"
      >
        Connections
      </h2>
      <p className="text-muted-foreground text-xs">
        Your own accounts the agent can work in. Each person connects their own;
        the agent never sees the password.
      </p>
      {connectors.map((connector) => (
        <ConnectorCard key={connector.id} connector={connector} />
      ))}
    </section>
  );
};

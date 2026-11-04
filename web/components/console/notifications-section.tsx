"use client";

// Settings → Notifications: the opt-in for system notifications in this browser, and a switch per kind.
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  NOTIFY_KIND_LABEL,
  NOTIFY_KINDS,
  notificationSupport,
  showNotification,
  useNotificationPrefs,
  writePrefs,
} from "@/lib/notifications";
import type { NotificationSupport } from "@/lib/notifications";

const supportNote: Partial<Record<NotificationSupport, string>> = {
  unsupported:
    "This browser cannot show notifications for this page: they need HTTPS (or localhost).",
  denied:
    "Notifications are blocked for this site. Allow them in the browser's site settings, then reload the page.",
};

export const NotificationsSection = () => {
  const prefs = useNotificationPrefs();
  // Read on the client only: the server render has no Notification API.
  const [support, setSupport] = useState<NotificationSupport | undefined>(() =>
    typeof window === "undefined" ? undefined : notificationSupport()
  );
  const on = prefs.enabled && support === "granted";
  const note = support === undefined ? undefined : supportNote[support];

  const turn = async (enabled: boolean) => {
    if (enabled && support === "default") {
      const answer = await Notification.requestPermission();
      setSupport(answer);
      if (answer !== "granted") {
        return;
      }
    }
    writePrefs({ ...prefs, enabled });
  };

  return (
    <section
      aria-labelledby="notifications-heading"
      className="flex flex-col gap-2"
    >
      <h2
        id="notifications-heading"
        className="font-heading text-sm font-semibold"
      >
        Notifications
      </h2>
      <p className="text-muted-foreground text-xs">
        A system notification when a conversation needs you or finished, while
        this tab is in the background or you are in another conversation. This
        browser only, while the console is open in a tab.
      </p>
      {note === undefined ? null : (
        <p className="text-muted-foreground text-xs">{note}</p>
      )}
      <div className="flex items-center gap-2 text-sm">
        <Switch
          size="sm"
          aria-label="Notify me"
          checked={on}
          disabled={support !== "default" && support !== "granted"}
          onCheckedChange={(checked) => {
            turn(checked);
          }}
        />
        <span aria-hidden>Notify me</span>
      </div>
      <div className="flex flex-col gap-1.5 pl-1">
        {NOTIFY_KINDS.map((kind) => (
          <div key={kind} className="flex items-center gap-2 text-sm">
            <Switch
              size="sm"
              aria-label={NOTIFY_KIND_LABEL[kind]}
              checked={prefs.kinds[kind]}
              disabled={!on}
              onCheckedChange={(checked) =>
                writePrefs({
                  ...prefs,
                  kinds: { ...prefs.kinds, [kind]: checked },
                })
              }
            />
            <span aria-hidden>{NOTIFY_KIND_LABEL[kind]}</span>
          </div>
        ))}
      </div>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={!on}
          onClick={() =>
            showNotification(
              {
                title: "Notifications are on",
                body: "This is how a conversation will reach you.",
                tag: "test",
              },
              () => null
            )
          }
        >
          Send a test notification
        </Button>
      </div>
    </section>
  );
};

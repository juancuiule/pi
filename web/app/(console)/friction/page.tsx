"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import type { ConversationSummary, FrictionEntryInfo } from "effect-pi/api";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/console/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { conversationTitleOf } from "@/lib/artifacts";
import { relativeTime } from "@/lib/format";
import {
  FRICTION_ACTIONS,
  FRICTION_VIEW_IDS,
  FRICTION_VIEWS,
  frictionCounts,
  frictionView,
} from "@/lib/friction";
import type { FrictionView } from "@/lib/friction";
import {
  useConversations,
  useFriction,
  useTriageFriction,
} from "@/lib/queries";
import { useNow } from "@/lib/use-now";

// Notes past this many fold behind a toggle; the latest stay in view.
const VISIBLE_NOTES = 3;

const ConversationLink = ({
  conversations,
  id,
}: {
  conversations: readonly ConversationSummary[] | undefined;
  id: number;
}) => {
  const title = conversationTitleOf(conversations, id);
  return (
    <Link
      href={`/?c=${id}`}
      title={title}
      className="hover:text-foreground focus-visible:ring-ring min-w-0 truncate rounded-sm outline-none focus-visible:ring-2"
    >
      {title}
    </Link>
  );
};

type Note = FrictionEntryInfo["notes"][number];

const NoteList = ({
  notes,
  conversations,
  now,
}: {
  notes: readonly Note[];
  conversations: readonly ConversationSummary[] | undefined;
  now: number;
}) => (
  <ol className="flex flex-col gap-2">
    {notes.map((note) => (
      <li
        key={`${note.createdAt}:${note.conversationId}:${note.text}`}
        className="border-l-2 pl-3"
      >
        <p className="text-sm wrap-break-word whitespace-pre-wrap">
          {note.text}
        </p>
        <p className="text-muted-foreground flex min-w-0 gap-1 text-xs">
          <span className="shrink-0">
            {relativeTime(note.createdAt, now)}
            {" · "}
          </span>
          <ConversationLink
            conversations={conversations}
            id={note.conversationId}
          />
        </p>
      </li>
    ))}
  </ol>
);

const FrictionPage = () => {
  const [view, setView] = useState<FrictionView>("open");
  const { data: entries } = useFriction();
  const { data: conversations } = useConversations();
  const triage = useTriageFriction();
  const now = useNow();

  const counts = frictionCounts(entries ?? []);
  const shown = frictionView(entries ?? [], view);
  const { empty } = FRICTION_VIEWS[view];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <title>Friction · effect-pi</title>
      <PageHeader title="Friction" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          <div className="flex flex-wrap gap-1">
            {FRICTION_VIEW_IDS.map((id) => (
              <Button
                key={id}
                variant={view === id ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {FRICTION_VIEWS[id].label}
                <span className="text-muted-foreground tabular-nums">
                  {counts[id]}
                </span>
              </Button>
            ))}
          </div>
          {entries !== undefined && shown.length === 0 ? (
            <div>
              <p className="text-muted-foreground text-sm">{empty.title}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {empty.detail}
              </p>
            </div>
          ) : null}
          <ul className="flex flex-col gap-4">
            {shown.map((entry) => {
              const earlier = entry.notes.slice(0, -VISIBLE_NOTES);
              const latest = entry.notes.slice(-VISIBLE_NOTES);
              const pending =
                triage.isPending && triage.variables.id === entry.id;
              return (
                <li
                  key={entry.id}
                  className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h2 className="font-heading min-w-0 text-sm font-medium wrap-break-word">
                        {entry.title}
                      </h2>
                      <Badge variant="secondary">{entry.scope}</Badge>
                      {entry.status === "open" ? null : (
                        <Badge variant="outline">{entry.status}</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground flex min-w-0 gap-1 text-xs">
                      <span className="shrink-0">
                        {entry.id}
                        {" · "}
                        {relativeTime(entry.createdAt, now)}
                        {" · "}
                      </span>
                      <ConversationLink
                        conversations={conversations}
                        id={entry.conversationId}
                      />
                    </p>
                  </div>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div>
                      <dt className="text-muted-foreground text-xs">
                        What happened
                      </dt>
                      <dd className="wrap-break-word whitespace-pre-wrap">
                        {entry.whatHappened}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs">
                        Expected, or why it hurt
                      </dt>
                      <dd className="wrap-break-word whitespace-pre-wrap">
                        {entry.expectedOrWhyItHurt}
                      </dd>
                    </div>
                  </dl>
                  {entry.notes.length > 0 ? (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-muted-foreground text-xs">
                        Notes ({entry.notes.length})
                      </h3>
                      {earlier.length > 0 ? (
                        <Collapsible.Root className="flex flex-col gap-2">
                          <Collapsible.Trigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring group flex w-fit items-center gap-1 rounded-sm text-xs outline-none focus-visible:ring-2">
                            <ChevronRight
                              aria-hidden
                              className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90"
                            />
                            {earlier.length === 1
                              ? "1 earlier note"
                              : `${earlier.length} earlier notes`}
                          </Collapsible.Trigger>
                          <Collapsible.Panel>
                            <NoteList
                              notes={earlier}
                              conversations={conversations}
                              now={now}
                            />
                          </Collapsible.Panel>
                        </Collapsible.Root>
                      ) : null}
                      <NoteList
                        notes={latest}
                        conversations={conversations}
                        now={now}
                      />
                    </section>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {FRICTION_ACTIONS[entry.status].map((action) => (
                      <Button
                        key={action.status}
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          triage.mutate({
                            id: entry.id,
                            status: action.status,
                          })
                        }
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </ScrollArea>
    </div>
  );
};

export default FrictionPage;

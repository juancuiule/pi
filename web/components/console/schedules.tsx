"use client";

// Schedules in the console: the form that makes one (a follow-up into a conversation, or a new conversation per
// run), and the list with pause, resume and cancel. The /schedules page shows every schedule; the conversation
// header's clock shows that conversation's follow-ups.
import type { SandboxChoice, Schedule } from "effect-pi/api";
import { CalendarClock, Pause, Play, X } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateSchedule,
  useScheduleAction,
  useScheduleRuns,
  useSchedules,
  useTimeZone,
} from "@/lib/queries";
import { describeWhen, runLabel, statusLine, whenOf } from "@/lib/schedules";
import type { Repeat, WhenForm } from "@/lib/schedules";

const FIELD =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring h-7 rounded-md border px-2 text-base outline-none focus-visible:ring-3 md:text-xs";

const REPEATS: readonly { value: Repeat; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "cron", label: "Cron" },
];

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const LEVELS: readonly { value: SandboxChoice; label: string }[] = [
  { value: "none", label: "No machine" },
  { value: "shell", label: "Shell" },
  { value: "desktop", label: "Desktop" },
];

/** Make a schedule: into `conversation` when given, otherwise a new conversation per run. */
export const ScheduleForm = ({
  conversation,
  onCreated,
}: {
  conversation?: number;
  onCreated?: () => void;
}) => {
  const id = useId();
  const { data: zone } = useTimeZone();
  const create = useCreateSchedule();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [when, setWhen] = useState<WhenForm>({
    repeat: conversation === undefined ? "daily" : "once",
    at: "",
    time: "09:00",
    weekday: 1,
    cron: "",
  });
  const [level, setLevel] = useState<SandboxChoice>("none");
  const [ask, setAsk] = useState(false);
  const [error, setError] = useState<string>();
  const resolved = whenOf(when);

  const submit = () => {
    if (title.trim() === "" || prompt.trim() === "" || resolved === undefined) {
      setError("Give it a title, a message and a time.");
      return;
    }
    setError(undefined);
    const fields = { title: title.trim(), prompt, when: resolved };
    create.mutate(
      conversation === undefined
        ? {
            kind: "new",
            payload: {
              ...fields,
              sandbox: level,
              approvals: ask ? "ask" : "auto",
            },
          }
        : { kind: "followUp", conversation, payload: fields },
      {
        onSuccess: () => {
          setTitle("");
          setPrompt("");
          toast.success("Scheduled");
          onCreated?.();
        },
        onError: (failure) => setError(failure.message),
      }
    );
  };

  return (
    <form
      className="flex flex-col gap-2"
      aria-label={conversation === undefined ? "New schedule" : "New follow-up"}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        className={FIELD}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={
          conversation === undefined ? "Morning summary" : "Check the deploy"
        }
        aria-label="Title"
        maxLength={120}
      />
      <Textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={
          conversation === undefined
            ? "The message each new conversation starts with — it sees nothing else, so say everything it needs."
            : "The message to send into this conversation."
        }
        aria-label="Message"
        className="min-h-20"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={FIELD}
          value={when.repeat}
          aria-label="How often"
          onChange={(event) =>
            setWhen({ ...when, repeat: event.target.value as Repeat })
          }
        >
          {REPEATS.map((repeat) => (
            <option key={repeat.value} value={repeat.value}>
              {repeat.label}
            </option>
          ))}
        </select>
        {when.repeat === "once" ? (
          <input
            type="datetime-local"
            className={FIELD}
            value={when.at}
            aria-label="When"
            onChange={(event) => setWhen({ ...when, at: event.target.value })}
          />
        ) : null}
        {when.repeat === "weekly" ? (
          <select
            className={FIELD}
            value={when.weekday}
            aria-label="Day"
            onChange={(event) =>
              setWhen({ ...when, weekday: Number(event.target.value) })
            }
          >
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        ) : null}
        {when.repeat === "daily" ||
        when.repeat === "weekdays" ||
        when.repeat === "weekly" ? (
          <input
            type="time"
            className={FIELD}
            value={when.time}
            aria-label="At"
            onChange={(event) => setWhen({ ...when, time: event.target.value })}
          />
        ) : null}
        {when.repeat === "cron" ? (
          <input
            className={`${FIELD} font-mono`}
            value={when.cron}
            placeholder="0 9 * * 1-5"
            aria-label="Cron, five fields"
            onChange={(event) => setWhen({ ...when, cron: event.target.value })}
          />
        ) : null}
      </div>
      {conversation === undefined ? (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5" htmlFor={`${id}-level`}>
            Machine
            <select
              id={`${id}-level`}
              className={FIELD}
              value={level}
              onChange={(event) =>
                setLevel(event.target.value as SandboxChoice)
              }
            >
              {LEVELS.map((each) => (
                <option key={each.value} value={each.value}>
                  {each.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={ask}
              onChange={(event) => setAsk(event.target.checked)}
            />
            Ask before tools run (the run waits for you)
          </label>
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Times are in {zone?.timeZone ?? "your time zone"}.
      </p>
      {error === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={create.isPending}
      >
        Schedule
      </Button>
    </form>
  );
};

const ScheduleRuns = ({ schedule }: { schedule: Schedule }) => {
  const { data } = useScheduleRuns(schedule.id);
  if (data === undefined || data.runs.length === 0) {
    return <p className="text-muted-foreground text-xs">No runs yet.</p>;
  }
  return (
    <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
      {data.runs.map((run) => (
        <li key={run.due}>
          {run.conversation === undefined ? (
            runLabel(run, schedule.timeZone)
          ) : (
            <Link
              href={`/?c=${run.conversation}`}
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              {runLabel(run, schedule.timeZone)}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
};

const ScheduleRow = ({
  schedule,
  showTarget,
}: {
  schedule: Schedule;
  showTarget: boolean;
}) => {
  const act = useScheduleAction();
  const [open, setOpen] = useState(false);
  const live = schedule.status === "active" || schedule.status === "paused";
  const run = (action: "pause" | "resume" | "cancel") =>
    act.mutate(
      { id: schedule.id, action },
      { onError: (failure) => toast.error(failure.message) }
    );
  return (
    <li className="flex flex-col gap-1 rounded-md border px-3 py-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="w-full truncate text-sm" title={schedule.title}>
            {schedule.title}
          </span>
          <span className="text-muted-foreground text-xs">
            {describeWhen(schedule)} · {schedule.timeZone}
            {showTarget
              ? ` · ${
                  schedule.target.kind === "conversation"
                    ? "follow-up"
                    : "new conversation each run"
                }`
              : ""}
            {schedule.createdBy === "agent" ? " · set by the agent" : ""}
          </span>
          <span className="text-xs">{statusLine(schedule)}</span>
        </button>
        {live ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={schedule.status === "paused" ? "Resume" : "Pause"}
              title={schedule.status === "paused" ? "Resume" : "Pause"}
              disabled={act.isPending}
              onClick={() =>
                run(schedule.status === "paused" ? "resume" : "pause")
              }
            >
              {schedule.status === "paused" ? <Play /> : <Pause />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Cancel schedule"
              title="Cancel schedule"
              disabled={act.isPending}
              onClick={() => run("cancel")}
            >
              <X />
            </Button>
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-1.5 pt-1">
          <p className="text-xs whitespace-pre-wrap">{schedule.prompt}</p>
          {showTarget && schedule.target.kind === "conversation" ? (
            <Link
              href={`/?c=${schedule.target.conversation}`}
              className="text-muted-foreground hover:text-foreground w-fit text-xs underline-offset-2 hover:underline"
            >
              Open its conversation
            </Link>
          ) : null}
          <ScheduleRuns schedule={schedule} />
        </div>
      ) : null}
    </li>
  );
};

const rank = (schedule: Schedule) =>
  schedule.status === "active" || schedule.status === "paused" ? 0 : 1;

/** Schedules, live ones first; `conversation` narrows to the follow-ups into it. */
export const ScheduleList = ({ conversation }: { conversation?: number }) => {
  const { data: schedules } = useSchedules(conversation);
  if (schedules === undefined) {
    return null;
  }
  if (schedules.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {conversation === undefined
          ? "No schedules yet. Make one here, or ask the agent to do something later."
          : "No follow-ups for this conversation."}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {schedules
        .toSorted((a, b) => rank(a) - rank(b))
        .map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            showTarget={conversation === undefined}
          />
        ))}
    </ul>
  );
};

/** The conversation header's clock: this conversation's follow-ups, and a form for another. */
export const ConversationSchedules = ({
  conversation,
}: {
  conversation: number;
}) => {
  const [open, setOpen] = useState(false);
  const { data: schedules } = useSchedules(conversation);
  const live = (schedules ?? []).filter(
    (schedule) => schedule.status === "active"
  ).length;
  const label = live === 0 ? "Follow-ups" : `Follow-ups (${live} scheduled)`;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={label}
        className="relative"
        onClick={() => setOpen(true)}
      >
        <CalendarClock />
        {live === 0 ? null : (
          <span className="bg-primary absolute top-1 right-1 size-1.5 rounded-full" />
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Follow-ups</SheetTitle>
            <SheetDescription>
              Messages sent into this conversation later, or on a repeat.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-6 px-4 pb-6">
              <ScheduleForm conversation={conversation} />
              <ScheduleList conversation={conversation} />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
};

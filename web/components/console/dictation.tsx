"use client";

// The composer's dictation controls: the language toggle and the mic button (with its level meter) beside Send, and
// the live strip above the textarea that shows the words still being heard, muted and italic, until they become final
// and move into the prompt. State lives in useDictation (web/lib/use-dictation.ts).
import { Check, LoaderCircle, Mic, MicOff, X } from "lucide-react";
import type { CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import {
  DICTATION_PROBLEMS,
  formatElapsed,
  languageLabel,
  languageName,
  nextLanguage,
} from "@/lib/dictation";
import type { Dictation } from "@/lib/use-dictation";
import { cn } from "@/lib/utils";

const SHORTCUT =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/u.test(navigator.userAgent)
    ? "⌘⇧Space"
    : "Ctrl+Shift+Space";

const BAR_WEIGHTS = [0.55, 0.8, 1, 0.8, 0.55] as const;

/** Five bars that follow the microphone's level; decoration, hidden from screen readers. */
const LevelBars = ({ level }: { level: number }) => (
  <span aria-hidden className="flex h-3.5 items-center gap-0.5">
    {BAR_WEIGHTS.map((weight, index) => (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- fixed bars, never reordered
        key={index}
        className="h-(--bar) w-0.5 rounded-full bg-current transition-all duration-75 motion-reduce:transition-none"
        style={
          {
            "--bar": `${Math.max(18, Math.min(100, level * weight * 100))}%`,
          } as CSSProperties
        }
      />
    ))}
  </span>
);

const buttonLabel = (dictation: Dictation) => {
  if (dictation.status === "listening") {
    return `Stop dictation (${SHORTCUT})`;
  }
  if (dictation.status === "starting") {
    return "Starting dictation; press to cancel";
  }
  if (dictation.status === "finishing") {
    return "Finishing dictation";
  }
  return dictation.availability === "insecure"
    ? "Dictation needs https or localhost"
    : `Start dictation (${SHORTCUT})`;
};

const ButtonIcon = ({ dictation }: { dictation: Dictation }) => {
  if (dictation.status === "listening") {
    return <LevelBars level={dictation.level} />;
  }
  if (dictation.status !== "idle") {
    return <LoaderCircle className="motion-safe:animate-spin" />;
  }
  return dictation.availability === "ok" ? <Mic /> : <MicOff />;
};

/** The language for the next dictation, and the mic toggle. */
export const DictationButton = ({
  dictation,
  onToggle,
}: {
  dictation: Dictation;
  /** Starts (remembering the caret) or stops. */
  onToggle: () => void;
}) => {
  const { status, language } = dictation;
  const label = buttonLabel(dictation);
  if (!dictation.enabled) {
    return null;
  }
  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="xs"
        aria-label={`Dictation language: ${languageName(language)}. Change`}
        title={`Dictation language: ${languageName(language)}`}
        disabled={status !== "idle"}
        onClick={() => dictation.setLanguage(nextLanguage(language))}
      >
        <span className="text-muted-foreground font-mono">
          {languageLabel(language)}
        </span>
      </Button>
      <Button
        variant={status === "listening" ? "destructive" : "ghost"}
        size="icon-sm"
        aria-label={label}
        title={label}
        aria-pressed={status === "listening"}
        // Stays focusable when the page cannot record, so a click can explain why.
        aria-disabled={status === "finishing"}
        onClick={onToggle}
      >
        <ButtonIcon dictation={dictation} />
      </Button>
    </div>
  );
};

const stripText = (dictation: Dictation) => {
  if (dictation.interim !== "") {
    return dictation.interim;
  }
  if (dictation.status === "starting") {
    return "Starting the microphone…";
  }
  return dictation.status === "finishing" ? "Finishing…" : "Listening…";
};

/** The timer, red in the last 30 seconds before the server's limit. */
const Timer = ({ dictation }: { dictation: Dictation }) => {
  const { maxSeconds, elapsedMs, status } = dictation;
  const nearLimit =
    maxSeconds !== undefined && maxSeconds - elapsedMs / 1000 <= 30;
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 pt-0.5 font-mono text-xs tabular-nums">
      {status === "listening" ? (
        <span
          aria-hidden
          className="bg-destructive size-2 rounded-full motion-safe:animate-pulse"
        />
      ) : null}
      <span
        className={cn(nearLimit && "text-destructive")}
        title={
          maxSeconds === undefined
            ? undefined
            : `Dictation stops at ${formatElapsed(maxSeconds * 1000)}`
        }
      >
        {formatElapsed(elapsedMs)}
      </span>
    </span>
  );
};

/** Above the textarea while dictating or after a problem: what is being heard, the timer, Cancel and Done. */
export const DictationStrip = ({ dictation }: { dictation: Dictation }) => {
  const { status, interim, problem } = dictation;
  const active = status !== "idle";
  if (!dictation.enabled) {
    return null;
  }
  return (
    <>
      {/* Final text is announced once, as it lands in the prompt; interim text would chatter. */}
      <span aria-live="polite" className="sr-only">
        {dictation.announcement === ""
          ? ""
          : `Dictated: ${dictation.announcement}`}
      </span>
      {!active && problem === undefined ? null : (
        <div className="flex items-start gap-2 rounded-lg px-2 py-1 text-sm">
          {active ? <Timer dictation={dictation} /> : null}
          {problem === undefined ? (
            <p className="text-muted-foreground line-clamp-2 min-w-0 flex-1 pt-px [overflow-wrap:anywhere] italic">
              {stripText(dictation)}
              {interim === "" ? null : (
                <span
                  aria-hidden
                  className="bg-muted-foreground ml-0.5 inline-block h-[1em] w-px align-text-bottom motion-safe:animate-pulse"
                />
              )}
            </p>
          ) : (
            <p role="alert" className="text-destructive min-w-0 flex-1 pt-px">
              {DICTATION_PROBLEMS[problem]}
            </p>
          )}
          {active ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Cancel dictation (Escape)"
                title="Cancel (Esc): drop what is being heard"
                onClick={() => dictation.cancel()}
              >
                <X />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Finish dictation (${SHORTCUT})`}
                title={`Done (${SHORTCUT})`}
                disabled={status !== "listening"}
                onClick={() => dictation.stop()}
              >
                <Check />
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => dictation.dismissProblem()}
            >
              <X />
            </Button>
          )}
        </div>
      )}
    </>
  );
};

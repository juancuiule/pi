"use client";

import type { DictationLanguage } from "effect-pi/api";
// Dictation for the composer: the microphone through an AudioWorklet, resampled to 16 kHz PCM16 and streamed over the
// `/api/dictation` socket, with the server's interim text for the live strip and its final text handed to `onFinal`
// for the composer to insert. One dictation at a time; Stop finishes what was said, Cancel drops it.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  availabilityOf,
  createResampler,
  interimOf,
  levelOf,
  parseDictationMessage,
  parseLanguage,
  pcmFrame,
  problemOfMediaError,
  storedLanguage,
} from "./dictation";
import type { DictationAvailability, DictationProblem } from "./dictation";
import { useInfo } from "./queries";
import { serverSocketUrl } from "./server-socket";

export type DictationStatus = "idle" | "starting" | "listening" | "finishing";

const LANGUAGE_KEY = "effect-pi.dictation.language";
/** Samples per binary frame: 100 ms at 16 kHz. */
const FRAME_SAMPLES = 1600;
/** Silence at the start that earns a "no sound" hint. */
const NO_SOUND_MS = 3000;
/** How long Stop waits for the last final before giving up on it. */
const FINISH_TIMEOUT_MS = 30_000;

// The language choice, remembered per browser: read from localStorage once, then kept here so every composer agrees.
// The server snapshot is the default, so the first render matches the server's.
let language: DictationLanguage | null | undefined;
const languageListeners = new Set<() => void>();

const currentLanguage = (): DictationLanguage | null => {
  if (language === undefined) {
    try {
      language = parseLanguage(localStorage.getItem(LANGUAGE_KEY));
    } catch {
      language = "es";
    }
  }
  return language;
};

const subscribeLanguage = (listener: () => void) => {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
};

const chooseLanguage = (next: DictationLanguage | null) => {
  language = next;
  try {
    localStorage.setItem(LANGUAGE_KEY, storedLanguage(next));
  } catch {
    // Private windows may refuse storage; the choice lasts for this page.
  }
  for (const listener of languageListeners) {
    listener();
  }
};

const subscribeNothing = () => () => {
  // The page's security and APIs do not change while it is open.
};

const pageAvailability = (): DictationAvailability =>
  typeof window === "undefined"
    ? "unsupported"
    : availabilityOf({
        isSecureContext: window.isSecureContext,
        hasMediaDevices: navigator.mediaDevices?.getUserMedia !== undefined,
        hasAudioWorklet: typeof AudioWorkletNode !== "undefined",
      });

/** The microphone, the audio graph and the socket of one dictation. */
interface Capture {
  stream?: MediaStream;
  context?: AudioContext;
  socket?: WebSocket;
  /** Frames recorded before the socket opened. */
  queued: ArrayBuffer[];
  ready: boolean;
  done: boolean;
  finishTimer?: ReturnType<typeof setTimeout>;
}

const closeQuietly = async (context: AudioContext | undefined) => {
  try {
    await context?.close();
  } catch {
    // Already closed.
  }
};

export const useDictation = ({
  onFinal,
}: {
  /** A segment's final text, to insert where dictation started. */
  readonly onFinal: (text: string) => void;
}) => {
  const { data: info } = useInfo();
  const enabled = info?.dictation === true;
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [startedAt, setStartedAt] = useState<number>();
  const [now, setNow] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState<number>();
  const [problem, setProblem] = useState<DictationProblem>();
  const [heard, setHeard] = useState(false);
  const chosen = useSyncExternalStore(
    subscribeLanguage,
    currentLanguage,
    () => "es" as const
  );
  const availability = useSyncExternalStore(
    subscribeNothing,
    pageAvailability,
    (): DictationAvailability => "ok"
  );
  // The last finalized text, for the screen reader's announcement.
  const [announcement, setAnnouncement] = useState("");
  const capture = useRef<Capture | null>(null);
  const segments = useRef(new Map<number, string>());
  const finalRef = useRef(onFinal);
  useLayoutEffect(() => {
    finalRef.current = onFinal;
  });

  /** Releases the microphone and the audio graph; the socket stays open unless `close`. */
  const release = useCallback((close: boolean) => {
    const { current } = capture;
    if (current === null) {
      return;
    }
    for (const track of current.stream?.getTracks() ?? []) {
      track.stop();
    }
    current.stream = undefined;
    void closeQuietly(current.context);
    current.context = undefined;
    setLevel(0);
    if (close) {
      clearTimeout(current.finishTimer);
      current.done = true;
      current.socket?.close();
      capture.current = null;
      segments.current.clear();
      setInterim("");
      setStartedAt(undefined);
      setStatus("idle");
    }
  }, []);

  const fail = useCallback(
    (reason: DictationProblem) => {
      setProblem(reason);
      release(true);
    },
    [release]
  );

  const onMessage = useCallback(
    (raw: string) => {
      const message = parseDictationMessage(raw);
      if (message === undefined) {
        return;
      }
      switch (message.type) {
        case "ready": {
          setMaxSeconds(message.maxSeconds);
          return;
        }
        case "interim": {
          segments.current.set(message.segment, message.text);
          setInterim(interimOf(segments.current));
          return;
        }
        case "final": {
          segments.current.delete(message.segment);
          setInterim(interimOf(segments.current));
          if (message.text.trim() !== "") {
            finalRef.current(message.text);
            setAnnouncement(message.text);
          }
          return;
        }
        case "limit": {
          release(false);
          setStatus("finishing");
          return;
        }
        case "error": {
          fail(message.reason === "protocol" ? "protocol" : "unavailable");
          return;
        }
        case "done": {
          release(true);
          break;
        }
        default:
      }
    },
    [fail, release]
  );

  const start = useCallback(async () => {
    if (capture.current !== null || info === undefined) {
      return;
    }
    const available = pageAvailability();
    if (available !== "ok") {
      setProblem(available);
      return;
    }
    setProblem(undefined);
    setHeard(false);
    const current: Capture = { queued: [], ready: false, done: false };
    capture.current = current;
    setStatus("starting");
    try {
      current.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (capture.current === current) {
        fail(problemOfMediaError(error));
      }
      return;
    }
    if (capture.current !== current) {
      // Cancelled while the permission prompt was up.
      for (const track of current.stream.getTracks()) {
        track.stop();
      }
      return;
    }

    const socket = new WebSocket(
      serverSocketUrl({
        apiUrl: info.apiUrl,
        pageOrigin: window.location.origin,
        pathname: "/api/dictation",
      })
    );
    socket.binaryType = "arraybuffer";
    current.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "start", language: chosen }));
      for (const frame of current.queued) {
        socket.send(frame);
      }
      current.queued = [];
      current.ready = true;
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        onMessage(event.data);
      }
    });
    socket.addEventListener("close", () => {
      if (capture.current === current && !current.done) {
        fail("connection");
      }
    });

    try {
      const context = new AudioContext();
      current.context = context;
      await context.resume();
      await context.audioWorklet.addModule("/dictation-worklet.js");
      if (capture.current !== current) {
        return;
      }
      const source = context.createMediaStreamSource(current.stream);
      const node = new AudioWorkletNode(context, "dictation-capture");
      const resample = createResampler(context.sampleRate);
      let pending = new Int16Array(0);
      let lastLevel = 0;
      node.port.addEventListener("message", (event: MessageEvent) => {
        const block = event.data as Float32Array;
        const blockLevel = levelOf(block);
        // Rises at once, falls gently: a meter that reads as a voice, not as flicker.
        lastLevel = Math.max(blockLevel, lastLevel * 0.8);
        setLevel(lastLevel);
        if (blockLevel > 0.15) {
          setHeard(true);
        }
        const samples = resample(block);
        const joined = new Int16Array(pending.length + samples.length);
        joined.set(pending);
        joined.set(samples, pending.length);
        let offset = 0;
        for (
          ;
          offset + FRAME_SAMPLES <= joined.length;
          offset += FRAME_SAMPLES
        ) {
          const frame = pcmFrame(
            joined.subarray(offset, offset + FRAME_SAMPLES)
          );
          if (current.ready && socket.readyState === WebSocket.OPEN) {
            socket.send(frame);
          } else {
            current.queued.push(frame);
          }
        }
        pending = joined.slice(offset);
      });
      node.port.start();
      source.connect(node);
      // A node outside the rendered graph may not be pulled; its output is silence.
      node.connect(context.destination);
      setStartedAt(Date.now());
      setNow(Date.now());
      setStatus("listening");
    } catch {
      if (capture.current === current) {
        fail("unsupported");
      }
    }
  }, [chosen, fail, info, onMessage]);

  const stop = useCallback(() => {
    const { current } = capture;
    if (current === null) {
      return;
    }
    if (current.socket?.readyState !== WebSocket.OPEN) {
      release(true);
      return;
    }
    current.socket.send(JSON.stringify({ type: "stop" }));
    release(false);
    setStatus("finishing");
    current.finishTimer = setTimeout(() => {
      if (capture.current === current) {
        fail("unavailable");
      }
    }, FINISH_TIMEOUT_MS);
  }, [fail, release]);

  const cancel = useCallback(() => {
    const { current } = capture;
    if (current === null) {
      return;
    }
    if (current.socket?.readyState === WebSocket.OPEN) {
      current.socket.send(JSON.stringify({ type: "cancel" }));
    }
    release(true);
  }, [release]);

  const toggle = useCallback(() => {
    if (status === "idle") {
      void start();
    } else if (status === "listening") {
      stop();
    } else if (status === "starting") {
      cancel();
    }
  }, [cancel, start, status, stop]);

  // The timer ticks while listening.
  useEffect(() => {
    if (status !== "listening") {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [status]);

  // Leaving the page mid-dictation drops it.
  useEffect(() => () => release(true), [release]);

  const elapsedMs = startedAt === undefined ? 0 : Math.max(0, now - startedAt);
  const noSound = status === "listening" && !heard && elapsedMs > NO_SOUND_MS;

  return {
    enabled,
    availability,
    status,
    interim,
    level,
    elapsedMs,
    maxSeconds,
    problem: problem ?? (noSound ? ("no-sound" as const) : undefined),
    dismissProblem: () => setProblem(undefined),
    announcement,
    language: chosen,
    setLanguage: chooseLanguage,
    start,
    stop,
    cancel,
    toggle,
  };
};

export type Dictation = ReturnType<typeof useDictation>;

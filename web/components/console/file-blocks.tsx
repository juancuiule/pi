"use client";

// File-shaped tool surfaces rendered with @pierre/diffs: a file preview for `write`, a requested-changes diff for
// `edit` input, and the real patch for a finished `edit`. Its shadow DOM reads --diffs-* custom properties, so the
// console's fonts reach inside.
import { File, MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import type { FileContents, ThemesType } from "@pierre/diffs/react";
import { useTheme } from "next-themes";
import { useMemo, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Toggle } from "@/components/ui/toggle";
import type { EditHunk } from "@/lib/tool-input";

const THEME: ThemesType = { light: "github-light", dark: "github-dark" };

const DIFFS_STYLE: CSSProperties = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-header-font-family": "var(--font-sans)",
  "--diffs-font-size": "12.5px",
  "--diffs-line-height": "18px",
} as CSSProperties;

type DiffStyle = "unified" | "split";

// The stacked/split preference is shared across every diff in the transcript so toggling one flips them all; kept in
// module state rather than localStorage so server and client snapshots always agree.
let sharedDiffStyle: DiffStyle = "unified";
const diffStyleListeners = new Set<() => void>();

const subscribeDiffStyle = (listener: () => void) => {
  diffStyleListeners.add(listener);
  return () => {
    diffStyleListeners.delete(listener);
  };
};

const setDiffStyle = (next: DiffStyle) => {
  if (sharedDiffStyle === next) {
    return;
  }
  sharedDiffStyle = next;
  for (const listener of diffStyleListeners) {
    listener();
  }
};

const useDiffStyle = (): DiffStyle =>
  useSyncExternalStore(
    subscribeDiffStyle,
    () => sharedDiffStyle,
    () => "unified"
  );

const useThemeType = (): "system" | "light" | "dark" => {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "dark" || resolvedTheme === "light"
    ? resolvedTheme
    : "system";
};

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="border-input max-h-80 overflow-x-hidden overflow-y-auto rounded-lg border">
    {children}
  </div>
);

/** Sticky header row with the stacked/split switch, over the diff's own file header while it scrolls. */
const DiffToolbar = ({
  value,
  onChange,
}: {
  readonly value: DiffStyle;
  readonly onChange: (style: DiffStyle) => void;
}) => (
  <div className="border-input bg-card/95 sticky top-0 z-10 flex justify-end border-b px-2 py-1 backdrop-blur">
    <div className="flex gap-1">
      <Toggle
        size="sm"
        pressed={value === "unified"}
        onPressedChange={(pressed) => {
          if (pressed) {
            onChange("unified");
          }
        }}
      >
        Stacked
      </Toggle>
      <Toggle
        size="sm"
        pressed={value === "split"}
        onPressedChange={(pressed) => {
          if (pressed) {
            onChange("split");
          }
        }}
      >
        Split
      </Toggle>
    </div>
  </div>
);

/** A `write` call's file: filename header and numbered, highlighted contents. */
export const FilePreview = ({
  path,
  content,
}: {
  readonly path: string;
  readonly content: string;
}) => {
  const themeType = useThemeType();
  const options = useMemo(() => ({ theme: THEME, themeType }), [themeType]);
  const file = useMemo<FileContents>(
    () => ({ name: path, contents: content }),
    [path, content]
  );
  return (
    <Frame>
      <File file={file} options={options} style={DIFFS_STYLE} />
    </Frame>
  );
};

/** An `edit` call's requested hunks diffed as one pseudo-file. */
export const EditPreview = ({
  path,
  hunks,
}: {
  readonly path: string;
  readonly hunks: readonly EditHunk[];
}) => {
  const themeType = useThemeType();
  const diffStyle = useDiffStyle();
  const options = useMemo(
    () => ({ theme: THEME, themeType, diffStyle }),
    [themeType, diffStyle]
  );
  const files = useMemo<{ oldFile: FileContents; newFile: FileContents }>(
    () => ({
      oldFile: {
        name: path,
        contents: hunks.map((hunk) => hunk.oldText).join("\n"),
      },
      newFile: {
        name: path,
        contents: hunks.map((hunk) => hunk.newText).join("\n"),
      },
    }),
    [path, hunks]
  );
  return (
    <Frame>
      <DiffToolbar value={diffStyle} onChange={setDiffStyle} />
      <MultiFileDiff
        oldFile={files.oldFile}
        newFile={files.newFile}
        options={options}
        style={DIFFS_STYLE}
      />
    </Frame>
  );
};

/** The unified patch a finished `edit` produced (`details.patch`). */
export const PatchPreview = ({ patch }: { readonly patch: string }) => {
  const themeType = useThemeType();
  const diffStyle = useDiffStyle();
  const options = useMemo(
    () => ({ theme: THEME, themeType, diffStyle }),
    [themeType, diffStyle]
  );
  return (
    <Frame>
      <DiffToolbar value={diffStyle} onChange={setDiffStyle} />
      <PatchDiff patch={patch} options={options} style={DIFFS_STYLE} />
    </Frame>
  );
};

"use client";

import { createContext, useContext } from "react";

import type { OpenFile } from "./workspace-files";

/** Opens a workspace file beside the chat; the console page provides it, tool calls and the file browser consume it. */
export const OpenFileContext = createContext<
  ((file: OpenFile) => void) | undefined
>(undefined);

export const useOpenFile = () => useContext(OpenFileContext);

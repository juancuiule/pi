"use client";

import { createContext, useContext } from "react";

import type { OpenArtifact } from "./artifacts";

/** Opens an artifact beside the chat; the console page provides it, transcript cards consume it. */
export const OpenArtifactContext = createContext<
  ((artifact: OpenArtifact) => void) | undefined
>(undefined);

export const useOpenArtifact = () => useContext(OpenArtifactContext);

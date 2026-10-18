"use client";

import { createContext, useContext } from "react";

/** Opens the console's search palette; the console shell mounts it and owns its open state. */
export const SearchContext = createContext<() => void>(() => null);

export const useOpenSearch = () => useContext(SearchContext);

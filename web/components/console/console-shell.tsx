"use client";

// The console's chrome around every app page: the sidebar beside the page on desktop, in a Sheet below the
// breakpoint, and the Capacity guard both use. Pages get the Sheet's opener through `useOpenMenu`.
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SearchContext } from "@/lib/search-context";
import { DESKTOP_MEDIA, useMediaQuery } from "@/lib/use-media-query";

import { CapacityGuardProvider } from "./capacity-dialog";
import { SearchPalette } from "./search-palette";
import { Sidebar } from "./sidebar";

const MenuContext = createContext<() => void>(() => null);

/** Opens the mobile navigation sheet; the console shell answers it. */
export const useOpenMenu = () => useContext(MenuContext);

export const ConsoleShell = ({ children }: { children: ReactNode }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const pathname = usePathname();
  const query = useSearchParams().toString();
  // Any navigation closes the Sheet: a link, a router.push selection, back/forward.
  const url = `${pathname}?${query}`;
  const [seenUrl, setSeenUrl] = useState(url);
  if (seenUrl !== url) {
    setSeenUrl(url);
    setMenuOpen(false);
  }
  const isDesktop = useMediaQuery(DESKTOP_MEDIA);

  return (
    <MenuContext.Provider value={openMenu}>
      <SearchContext.Provider value={openSearch}>
        <CapacityGuardProvider>
          <a
            href="#main"
            className="bg-background ring-ring sr-only z-50 rounded-md px-3 py-2 text-sm outline-none focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:ring-2"
          >
            Skip to content
          </a>
          <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetContent side="left" className="w-72">
              <SheetTitle className="sr-only">Conversations</SheetTitle>
              <Sidebar />
            </SheetContent>
          </Sheet>
          {isDesktop === true ? (
            <ResizablePanelGroup orientation="horizontal" className="h-dvh">
              <ResizablePanel
                defaultSize="260px"
                minSize="220px"
                maxSize="420px"
              >
                <Sidebar />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel minSize="30%">
                <main
                  id="main"
                  tabIndex={-1}
                  className="h-full min-h-0 outline-none"
                >
                  {children}
                </main>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : null}
          {isDesktop === false ? (
            <main
              id="main"
              tabIndex={-1}
              className="flex h-dvh min-h-0 flex-col outline-none"
            >
              {children}
            </main>
          ) : null}
        </CapacityGuardProvider>
      </SearchContext.Provider>
    </MenuContext.Provider>
  );
};

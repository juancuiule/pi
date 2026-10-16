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
import { DESKTOP_MEDIA, useMediaQuery } from "@/lib/use-media-query";

import { CapacityGuardProvider } from "./capacity-dialog";
import { Sidebar } from "./sidebar";

const MenuContext = createContext<() => void>(() => null);

/** Opens the mobile navigation sheet; the console shell answers it. */
export const useOpenMenu = () => useContext(MenuContext);

export const ConsoleShell = ({ children }: { children: ReactNode }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
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
      <CapacityGuardProvider>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="w-72">
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <Sidebar />
          </SheetContent>
        </Sheet>
        {isDesktop === true ? (
          <ResizablePanelGroup orientation="horizontal" className="h-dvh">
            <ResizablePanel defaultSize="260px" minSize="220px" maxSize="420px">
              <Sidebar />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel minSize="30%">{children}</ResizablePanel>
          </ResizablePanelGroup>
        ) : null}
        {isDesktop === false ? (
          <div className="flex h-dvh flex-col">{children}</div>
        ) : null}
      </CapacityGuardProvider>
    </MenuContext.Provider>
  );
};

"use client";

import { Menu } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { useOpenMenu } from "./console-shell";

/** An app page's header: the mobile menu button, the title, and optional trailing actions. */
export const PageHeader = ({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) => {
  const openMenu = useOpenMenu();
  return (
    <header className="flex items-center gap-3 border-b px-3 py-2 md:px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Menu"
        className="md:hidden"
        onClick={openMenu}
      >
        <Menu />
      </Button>
      <h1 className="font-heading text-base font-semibold">{title}</h1>
      {children}
    </header>
  );
};

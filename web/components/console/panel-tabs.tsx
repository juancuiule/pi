"use client";

import { buttonVariants } from "@/components/ui/button";
import type { PanelTab } from "@/lib/sandbox-view";

/** The sandbox panel header's tab buttons. */
export const PanelTabs = ({
  tabs,
  tab,
  onTab,
}: {
  tabs: readonly (readonly [PanelTab, string])[];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) => (
  <div className="flex shrink-0 gap-1">
    {tabs.map(([value, label]) => (
      <button
        key={value}
        type="button"
        aria-pressed={tab === value}
        onClick={() => onTab(value)}
        className={buttonVariants({
          variant: tab === value ? "secondary" : "ghost",
          size: "sm",
        })}
      >
        {label}
      </button>
    ))}
  </div>
);

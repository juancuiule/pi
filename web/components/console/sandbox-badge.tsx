import type { SandboxChoice } from "effect-pi/api";
import { MessageSquare, Monitor, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SANDBOX_LABEL } from "@/lib/sandbox-info";

export const SANDBOX_INFO: Record<
  SandboxChoice,
  { icon: LucideIcon; label: string }
> = {
  none: { icon: MessageSquare, label: SANDBOX_LABEL.none },
  shell: { icon: SquareTerminal, label: SANDBOX_LABEL.shell },
  desktop: { icon: Monitor, label: SANDBOX_LABEL.desktop },
};

export const SandboxBadge = ({ sandbox }: { sandbox: SandboxChoice }) => {
  const { icon: Icon, label } = SANDBOX_INFO[sandbox];
  return (
    <Badge variant="outline" className="shrink-0 whitespace-nowrap">
      <Icon />
      {label}
    </Badge>
  );
};

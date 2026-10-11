import type { SandboxChoice } from "effect-pi/api";

import { Badge } from "@/components/ui/badge";

export const SandboxBadge = ({ sandbox }: { sandbox: SandboxChoice }) => (
  <Badge variant="outline" className="shrink-0">
    {sandbox}
  </Badge>
);

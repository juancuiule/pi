import { Suspense } from "react";
import type { ReactNode } from "react";

import { ConsoleShell } from "@/components/console/console-shell";

const ConsoleLayout = ({ children }: { children: ReactNode }) => (
  // The shell reads the URL; a static page needs this boundary for useSearchParams.
  <Suspense>
    <ConsoleShell>{children}</ConsoleShell>
  </Suspense>
);

export default ConsoleLayout;

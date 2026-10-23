import { Suspense } from "react";
import type { ReactNode } from "react";

import { AuthGate } from "@/components/console/auth-gate";
import { ConsoleShell } from "@/components/console/console-shell";

const ConsoleLayout = ({ children }: { children: ReactNode }) => (
  // The shell reads the URL; a static page needs this boundary for useSearchParams.
  <Suspense>
    <AuthGate>
      <ConsoleShell>{children}</ConsoleShell>
    </AuthGate>
  </Suspense>
);

export default ConsoleLayout;

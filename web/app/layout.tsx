import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Montserrat } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";
import { cn } from "@/lib/utils";

import { Providers } from "./providers";

const montserratHeading = Montserrat({
  subsets: ["latin"],
  variable: "--font-heading",
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-plex-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "effect-pi",
  description: "Agent console for effect-pi",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html
    lang="en"
    suppressHydrationWarning
    className={cn(
      "h-dvh",
      "antialiased",
      "font-sans",
      ibmPlexSans.variable,
      ibmPlexMono.variable,
      montserratHeading.variable
    )}
  >
    <body className="flex h-dvh flex-col overflow-hidden">
      <Providers>{children}</Providers>
    </body>
  </html>
);

export default RootLayout;

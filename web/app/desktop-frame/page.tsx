import type { Metadata } from "next";

import { DesktopFrame } from "@/components/console/desktop-frame";

export const metadata = { title: "Sandbox desktop" } satisfies Metadata;

const DesktopFramePage = async ({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => {
  const { conversation, control } = await searchParams;
  const raw = Array.isArray(conversation) ? conversation[0] : conversation;
  const id = raw === undefined ? Number.NaN : Number(raw);

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center p-4">
        <p className="text-sm">No desktop view for this sandbox.</p>
      </div>
    );
  }
  return <DesktopFrame conversation={id} control={control === "1"} />;
};

export default DesktopFramePage;

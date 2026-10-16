"use client";

// Every conversation's artifacts, most recently updated first; a row opens the page in the same sandboxed
// panel the chat uses — the open pair lives in the URL (`?c&artifact[&v]`), so a refresh or a link shares it.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import {
  ArtifactResizablePanel,
  ArtifactSheet,
} from "@/components/console/artifact-panel";
import { PageHeader } from "@/components/console/page-header";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  artifactUrl,
  conversationTitleOf,
  openArtifactOf,
} from "@/lib/artifacts";
import { relativeTime } from "@/lib/format";
import { useArtifacts, useConversations } from "@/lib/queries";
import { DESKTOP_MEDIA, useMediaQuery } from "@/lib/use-media-query";
import { useNow } from "@/lib/use-now";

const ArtifactsPage = () => {
  const router = useRouter();
  const open = openArtifactOf(useSearchParams());
  const close = () => router.push("/artifacts");
  const { data: artifacts } = useArtifacts();
  const { data: conversations } = useConversations();
  const isDesktop = useMediaQuery(DESKTOP_MEDIA);
  const now = useNow();

  const list = (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-6">
        {artifacts !== undefined && artifacts.length === 0 ? (
          <p className="text-muted-foreground text-sm">No artifacts yet.</p>
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {artifacts?.map((artifact) => (
            <li key={artifact.id} className="flex items-center gap-2">
              <Link
                href={artifactUrl(artifact.conversation, artifact.id)}
                aria-current={
                  open?.artifact.id === artifact.id ? "page" : undefined
                }
                className="hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none focus-visible:ring-2"
              >
                <span className="min-w-0 truncate text-sm">
                  {artifact.title}
                </span>
                <span className="text-muted-foreground text-xs">
                  v{artifact.versions.at(-1)?.version ?? "?"}
                  {" · "}
                  {relativeTime(artifact.updatedAt, now)}
                </span>
              </Link>
              <Link
                href={`/?c=${artifact.conversation}`}
                className="text-muted-foreground hover:bg-muted focus-visible:ring-ring/50 max-w-40 truncate rounded-md px-2 py-1.5 text-xs outline-none focus-visible:ring-2"
                title={conversationTitleOf(
                  conversations,
                  artifact.conversation
                )}
              >
                {conversationTitleOf(conversations, artifact.conversation)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </ScrollArea>
  );

  let body: ReactNode = null;
  if (isDesktop === true) {
    body = (
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel minSize="30%">{list}</ResizablePanel>
        <ArtifactResizablePanel
          artifact={open?.artifact}
          conversation={open?.conversation}
          onClose={close}
        />
      </ResizablePanelGroup>
    );
  } else if (isDesktop === false) {
    body = list;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <title>Artifacts · effect-pi</title>
      <PageHeader title="Artifacts" />
      {body}
      <ArtifactSheet
        artifact={open?.artifact}
        conversation={open?.conversation}
        isDesktop={isDesktop}
        onClose={close}
      />
    </div>
  );
};

export default ArtifactsPage;

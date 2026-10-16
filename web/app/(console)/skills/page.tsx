"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";

import { Markdown } from "@/components/console/markdown";
import { PageHeader } from "@/components/console/page-header";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDraft } from "@/lib/draft";
import { useCapabilities } from "@/lib/queries";

const SkillsPage = () => {
  const router = useRouter();
  const { data } = useCapabilities();

  const use = (name: string) => {
    // No composer is mounted here; the next one to mount takes the draft (useTakeDraft).
    useDraft.getState().offer(`/skill:${name} `);
    router.push("/");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <title>Skills · effect-pi</title>
      <PageHeader title="Skills" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          {data?.skillProblems.map((problem) => (
            <p key={problem} className="text-warning text-sm">
              {problem}
            </p>
          ))}
          {data?.skills.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No skills installed.
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {data?.skills.map((skill) => (
              <li key={skill.name}>
                <Collapsible.Root>
                  <Collapsible.Trigger className="hover:bg-muted focus-visible:ring-ring/50 group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2">
                    <ChevronRight
                      aria-hidden
                      className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-heading text-sm font-medium">
                        {skill.name}
                        {skill.modelInvocable ? null : (
                          <span className="text-muted-foreground text-xs font-normal">
                            {" · command only"}
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {skill.description}
                      </span>
                    </span>
                  </Collapsible.Trigger>
                  <Collapsible.Panel>
                    <div className="flex flex-col gap-3 py-2 pl-9">
                      <ul className="text-muted-foreground flex flex-col gap-0.5 font-mono text-xs">
                        {skill.files.map((file) => (
                          <li key={file}>{file}</li>
                        ))}
                      </ul>
                      <Markdown>{skill.body}</Markdown>
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => use(skill.name)}
                      >
                        Use in a new conversation
                      </Button>
                    </div>
                  </Collapsible.Panel>
                </Collapsible.Root>
              </li>
            ))}
          </ul>
        </div>
      </ScrollArea>
    </div>
  );
};

export default SkillsPage;

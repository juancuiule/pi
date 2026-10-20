"use client";

// A skill folder's text files, edited in place: SKILL.md (frontmatter included) first, then each bundled file.
// Saving writes the whole folder — org skills under SKILLS_ORG_DIR, shadowing a builtin of the same name.
import { Plus, X } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiError } from "@/lib/api";
import { useDeleteSkill, useSaveSkill, useSkill } from "@/lib/queries";

const SKILL_MD = "SKILL.md";

const SKELETON = `---
name: my-skill
description: What it does, and when the agent should use it.
---

# My skill

Steps for the agent.
`;

// org means the skill exists only in the writable store; overridden means its org copy shadows a builtin.
const destructiveAction = (
  origin: string | undefined,
  name: string | undefined
) => {
  if (origin === "org") {
    return {
      label: "Delete",
      body: `Delete "${name}" for every conversation.`,
    };
  }
  if (origin === "overridden") {
    return {
      label: "Revert to built-in",
      body: `Drop the custom "${name}"; the built-in version is used again.`,
    };
  }
};

const order = (files: Record<string, string>) =>
  [
    SKILL_MD,
    ...Object.keys(files)
      .filter((file) => file !== SKILL_MD)
      .toSorted(),
  ].filter((file) => file in files);

/** The folder editor behind /skills: `name` edits an existing skill, its absence creates one. */
export const SkillEditor = ({
  name,
  onDone,
}: {
  readonly name?: string;
  readonly onDone: () => void;
}) => {
  const { data } = useSkill(name);
  const save = useSaveSkill();
  const remove = useDeleteSkill();
  const [skillName, setSkillName] = useState("");
  // The folder's text files once the person has touched them; until then, the loaded or seeded copy.
  const [edited, setEdited] = useState<Record<string, string> | undefined>();
  const [newFile, setNewFile] = useState("");
  const [error, setError] = useState<string>();
  const creating = name === undefined;
  const files =
    edited ?? (creating ? { [SKILL_MD]: SKELETON } : (data?.files ?? {}));
  const origin = data?.origin;
  const binary = data?.binaryFiles ?? [];
  const pending = save.isPending || remove.isPending;
  // While the folder loads there is nothing to edit or save: saving would PUT an empty one, and adding a file
  // would seed `edited` with just it, wiping the real files when the data lands.
  const loading = !creating && data === undefined;
  const busy = pending || loading;
  const put = (file: string, content: string) =>
    setEdited({ ...files, [file]: content });
  const drop = (file: string) =>
    setEdited(
      Object.fromEntries(Object.entries(files).filter(([key]) => key !== file))
    );
  const destructive = destructiveAction(origin, name);
  return (
    <div className="flex flex-col gap-3">
      {creating ? (
        <input
          type="text"
          value={skillName}
          onChange={(event) => setSkillName(event.target.value)}
          placeholder="skill-name"
          aria-label="Skill name"
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring h-7 w-56 rounded-md border px-2 font-mono text-base outline-none focus-visible:ring-3 md:text-xs"
        />
      ) : (
        <p className="text-muted-foreground text-xs">
          The name is fixed — to rename, save this as a new skill and delete{" "}
          {name}.
        </p>
      )}
      {order(files).map((file) => (
        <div key={file} className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <label
              htmlFor={`skill-file-${file}`}
              className="text-muted-foreground min-w-0 flex-1 font-mono text-xs"
            >
              {file}
            </label>
            {file === SKILL_MD ? null : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${file}`}
                disabled={pending}
                onClick={() => drop(file)}
              >
                <X aria-hidden className="size-3.5" />
              </Button>
            )}
          </div>
          <Textarea
            id={`skill-file-${file}`}
            value={files[file] ?? ""}
            onChange={(event) => put(file, event.target.value)}
            disabled={busy}
          />
        </div>
      ))}
      {binary.length === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          Not editable here: {binary.join(", ")} — saving would drop{" "}
          {binary.length === 1 ? "it" : "them"}.
        </p>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const file = newFile.trim();
          if (file === "") {
            return;
          }
          if (file in files) {
            setError(`A file named ${file} already exists.`);
            return;
          }
          setError(undefined);
          setEdited({ ...files, [file]: "" });
          setNewFile("");
        }}
      >
        <input
          type="text"
          value={newFile}
          onChange={(event) => setNewFile(event.target.value)}
          placeholder="references/guide.md"
          aria-label="New file path"
          disabled={busy}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring h-7 min-w-0 flex-1 rounded-md border px-2 font-mono text-base outline-none focus-visible:ring-3 md:text-xs"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy || newFile.trim() === ""}
        >
          <Plus aria-hidden className="size-3.5" />
          Add file
        </Button>
      </form>
      {error === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={
            busy || binary.length > 0 || (creating && skillName.trim() === "")
          }
          onClick={() => {
            setError(undefined);
            save.mutate(
              { name: name ?? skillName.trim(), files },
              {
                onSuccess: onDone,
                onError: (mutationError) => setError(apiError(mutationError)),
              }
            );
          }}
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
        {destructive === undefined ? null : (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant="ghost" size="sm" disabled={pending}>
                  {destructive.label}
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{destructive.label}</AlertDialogTitle>
                <AlertDialogDescription>
                  {destructive.body}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    setError(undefined);
                    remove.mutate(name ?? "", {
                      onSuccess: onDone,
                      onError: (mutationError) =>
                        setError(apiError(mutationError)),
                    });
                  }}
                >
                  {destructive.label}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Applies to new conversations. For a running one, sync skills in its
        settings.
      </p>
    </div>
  );
};

"use client";

// Per-message feedback: thumbs up/down and a report, scored on the run's Langfuse trace. There is no
// server-side feedback state to read back — the clicked thumb is only marked locally.
import { Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeedback, useReport } from "@/lib/queries";

export const FeedbackActions = ({
  conversation,
  entry,
}: {
  conversation: number;
  entry: number;
}) => {
  const feedback = useFeedback(conversation);
  const report = useReport(conversation);
  const [picked, setPicked] = useState<0 | 1>();
  const [reported, setReported] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [comment, setComment] = useState("");
  const marked = picked !== undefined || reported;

  const thumb = (value: 0 | 1, label: string, icon: ReactNode) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            // The clicked thumb keeps a filled look; a second click upserts the score server-side.
            variant={picked === value ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={label}
            aria-pressed={picked === value}
            disabled={feedback.isPending}
            onClick={() =>
              feedback.mutate(
                { entry, value },
                { onSuccess: () => setPicked(value) }
              )
            }
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return (
    // Revealed on hover like the code-block's actions; always shown on touch (pointer-coarse). Once the
    // person rates or reports, the controls stay put so the answer keeps its mark.
    <div
      className={`flex items-center gap-0.5 transition-opacity ${
        marked
          ? "opacity-100"
          : "opacity-0 group-focus-within/feedback:opacity-100 group-hover/feedback:opacity-100 pointer-coarse:opacity-100"
      }`}
    >
      {thumb(1, "Good answer", <ThumbsUp />)}
      {thumb(0, "Bad answer", <ThumbsDown />)}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={reported ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="Report this answer"
              aria-pressed={reported}
              onClick={() => setReporting(true)}
            >
              <Flag />
            </Button>
          }
        />
        <TooltipContent>Report this answer</TooltipContent>
      </Tooltip>
      <AlertDialog open={reporting} onOpenChange={setReporting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Report this answer</AlertDialogTitle>
            <AlertDialogDescription>
              What went wrong with this answer?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label="Report comment"
            placeholder="Describe the problem…"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={comment.trim() === "" || report.isPending}
              onClick={() =>
                report.mutate(
                  { entry, comment: comment.trim() },
                  {
                    onSuccess: () => {
                      setReporting(false);
                      setReported(true);
                      setComment("");
                    },
                  }
                )
              }
            >
              {report.isPending ? "Reporting…" : "Report"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// `ask_user`: the agent asks the person one or more questions with options, as a form in the console, and gets
// each answer next to its question. A call waits like an approval (an ApprovalDoc entry marked `question`, see
// `waitForPerson`), so Stop, a restart and the console's waiting state work the same; it waits whatever the policy.
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";

import {
  ApprovalDoc,
  approvalKey,
  conversationRoot,
  waitForPerson,
} from "../approvals.ts";
import type { QuestionAnswer } from "../approvals.ts";

export const ASK_USER = "ask_user";

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Short unique id, such as q1" }),
  question: Type.String({ description: "The question, in one line" }),
  header: Type.Optional(
    Type.String({
      description: "A label of one to three words, such as Database",
    })
  ),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "The choice, in a few words" }),
      description: Type.Optional(
        Type.String({ description: "What picking it means" })
      ),
    }),
    { minItems: 2, maxItems: 6 }
  ),
  multiple: Type.Optional(
    Type.Boolean({
      description: "True when the person may pick several options",
    })
  ),
});

const Parameters = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
});

export type Question = Static<typeof QuestionSchema>;

export const SKIPPED =
  "The user skipped these questions without answering. Do not ask them again: go on with your best judgment and say what you assumed.";

/**
 * The tool result the model reads: each answered question with what was picked, keeping only labels of its own
 * options (one for a single-choice question) and a non-empty "Other" text, then the questions left unanswered.
 */
export const answersText = (
  questions: readonly Question[],
  answers: readonly QuestionAnswer[]
): string => {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const answered: {
    question: string;
    selected: string[];
    other?: string;
  }[] = [];
  const unanswered: string[] = [];
  for (const question of questions) {
    const answer = byId.get(question.id);
    const labels = new Set(question.options.map((option) => option.label));
    const picked = (answer?.selected ?? []).filter((label) =>
      labels.has(label)
    );
    const selected = question.multiple === true ? picked : picked.slice(0, 1);
    const other = answer?.other?.trim() ?? "";
    if (selected.length === 0 && other === "") {
      unanswered.push(question.question);
    } else {
      answered.push({
        question: question.question,
        selected,
        ...(other === "" ? {} : { other }),
      });
    }
  }
  return JSON.stringify({
    answers: answered,
    ...(unanswered.length > 0 ? { unanswered } : {}),
  });
};

export const questionsExtension = (): Extension =>
  defineExtension({
    name: "questions",
    tools: [
      defineTool({
        name: ASK_USER,
        description: [
          "Show the person a form with one to four questions and wait for the answers.",
          "Use it whenever you need them to decide, choose or give you a detail, instead of writing the questions in your reply; do not repeat them in your message.",
          "Each question has two to six options; set multiple when several can apply.",
          "The form always lets the person type their own answer instead, so do not add an 'Other' option.",
        ].join(" "),
        parameters: Parameters,
        // Asking again after a crash only shows the form again.
        replay: "safe",
        execute: async ({ questions }, api, context) => {
          const key = approvalKey(api.conversationId, api.callId);
          // A subagent's questions wait on its root conversation's doc, like its approvals.
          const rootId = await conversationRoot(
            api,
            api.conversationId,
            context
          );
          await api.commit(async (tx) => {
            const doc = await tx.doc(ApprovalDoc, rootId);
            doc.pending[key] = {
              conversationId: String(api.conversationId),
              callId: api.callId,
              tool: ASK_USER,
              requestedAt: Date.now(),
              question: true,
            };
          }, context);
          const reply = await waitForPerson(api, key, context);
          if (reply.decision === "deny") {
            return {
              content: [{ type: "text", text: SKIPPED }],
              details: { approval: "skipped" },
            };
          }
          const answers = reply.answers ?? [];
          return {
            content: [{ type: "text", text: answersText(questions, answers) }],
            details: { approval: "answered", answers },
          };
        },
      }),
    ],
  });

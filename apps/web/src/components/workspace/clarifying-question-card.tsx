"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ClarifyingOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

export type ClarifyingQuestionItem = {
  id: string;
  question: string;
  options: ClarifyingOption[];
  context?: string;
};

export type ClarifyingSession = {
  questions: ClarifyingQuestionItem[];
  toolCallId?: string;
  /** Persisted after submit. */
  submitted?: boolean;
};

export type ClarifyingAnswerValue =
  | { kind: "option"; label: string; description?: string }
  | { kind: "custom"; text: string }
  | { kind: "skipped" };

export function formatClarifyingAnswersBatch(
  questions: ClarifyingQuestionItem[],
  answers: Record<string, ClarifyingAnswerValue>
): string {
  const lines = ["Clarifying answers:"];
  questions.forEach((q, i) => {
    const a = answers[q.id];
    let answerText = "(no answer)";
    if (a?.kind === "option") {
      answerText = a.description?.trim()
        ? `${a.label} — ${a.description.trim()}`
        : a.label;
    } else if (a?.kind === "custom") {
      answerText = a.text.trim() || "(empty)";
    } else if (a?.kind === "skipped") {
      answerText = "(skipped)";
    }
    lines.push(`${i + 1}. Q: ${q.question}`);
    lines.push(`   A: ${answerText}`);
  });
  return lines.join("\n");
}

/** @deprecated single-answer helper kept for older message parsing */
export function formatClarifyingAnswer(option: ClarifyingOption): string {
  const desc = option.description?.trim();
  return desc
    ? `Clarifying answer: ${option.label} — ${desc}`
    : `Clarifying answer: ${option.label}`;
}

export const CLARIFYING_OTHER_PREFIX = "Clarifying answer: ";
export const CLARIFYING_BATCH_PREFIX = "Clarifying answers:";

export type ClarifyingAnswerPair = {
  question?: string;
  answer: string;
};

/** Detect clarifying-answer user messages for nicer bubble rendering. */
export function parseClarifyingUserMessage(
  content: string
): ClarifyingAnswerPair[] | null {
  const text = content.trim();
  if (!text) return null;

  if (text.startsWith(CLARIFYING_BATCH_PREFIX)) {
    const body = text.slice(CLARIFYING_BATCH_PREFIX.length).trim();
    const pairs: ClarifyingAnswerPair[] = [];
    const re = /^\d+\.\s*Q:\s*(.+)\n\s*A:\s*(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const question = match[1]?.trim();
      const answer = match[2]?.trim();
      if (!answer) continue;
      pairs.push({ question: question || undefined, answer });
    }
    return pairs.length ? pairs : null;
  }

  if (text.startsWith(CLARIFYING_OTHER_PREFIX)) {
    const answer = text.slice(CLARIFYING_OTHER_PREFIX.length).trim();
    return answer ? [{ answer }] : null;
  }

  return null;
}

export function ClarifyingAnswersBubble({
  pairs,
}: {
  pairs: ClarifyingAnswerPair[];
}) {
  return (
    <div className="not-typeset space-y-2.5 text-left">
      {pairs.map((pair, i) => (
        <div key={i} className="space-y-0.5">
          {pair.question ? (
            <div className="text-[12px] leading-snug text-muted-foreground">
              {pair.question}
            </div>
          ) : null}
          <div className="text-[14px] leading-snug text-foreground">
            {pair.answer}
          </div>
        </div>
      ))}
    </div>
  );
}

type ClarifyingQuestionsDockProps = {
  session: ClarifyingSession;
  disabled?: boolean;
  onSubmit: (answers: Record<string, ClarifyingAnswerValue>) => void;
  onDismiss: () => void;
  className?: string;
};

/** Multi-question clarifying dock above the chat composer. */
export function ClarifyingQuestionsDock({
  session,
  disabled = false,
  onSubmit,
  onDismiss,
  className,
}: ClarifyingQuestionsDockProps) {
  const questions = session.questions;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, ClarifyingAnswerValue>>({});
  const [customDraft, setCustomDraft] = useState("");

  const current = questions[index];
  const total = questions.length;
  const questionIdsKey = questions.map((q) => q.id).join("|");

  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setCustomDraft("");
  }, [session.toolCallId, questionIdsKey]);

  useEffect(() => {
    const a = current ? answers[current.id] : undefined;
    setCustomDraft(a?.kind === "custom" ? a.text : "");
  }, [index, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const allAnswered = useMemo(
    () => questions.every((q) => answers[q.id] != null),
    [questions, answers]
  );

  if (!current || total === 0) return null;

  const currentAnswer = current ? answers[current.id] : undefined;
  const selectedLabel =
    currentAnswer?.kind === "option" ? currentAnswer.label : undefined;

  function go(delta: number) {
    setIndex((i) => Math.min(total - 1, Math.max(0, i + delta)));
  }

  function setAnswer(qid: string, value: ClarifyingAnswerValue, advance: boolean) {
    const next = { ...answers, [qid]: value };
    setAnswers(next);
    if (!advance) return;

    const nextUnanswered = questions.findIndex(
      (q, i) => i > index && next[q.id] == null
    );
    if (nextUnanswered >= 0) {
      setIndex(nextUnanswered);
      return;
    }
    // If this was the last gap and everything is filled, submit.
    if (questions.every((q) => next[q.id] != null)) {
      onSubmit(next);
    }
  }

  function pickOption(opt: ClarifyingOption) {
    if (disabled || !current) return;
    setAnswer(
      current.id,
      {
        kind: "option",
        label: opt.label,
        description: opt.description,
      },
      true
    );
  }

  function applyCustom() {
    if (disabled || !current) return;
    const text = customDraft.trim();
    if (!text) return;
    setAnswer(current.id, { kind: "custom", text }, true);
  }

  function skipCurrent() {
    if (disabled || !current) return;
    setAnswer(current.id, { kind: "skipped" }, true);
  }

  return (
    <div className={cn("not-typeset w-full", className)}>
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm">
        <div className="flex items-start gap-3 border-b border-border/70 px-3.5 py-3">
          <p className="min-w-0 flex-1 text-[15px] font-medium leading-snug tracking-tight text-foreground">
            {current.question}
          </p>
          <div className="flex shrink-0 items-center gap-0.5 pt-0.5 text-muted-foreground">
            {total > 1 ? (
              <>
                <button
                  type="button"
                  aria-label="Previous question"
                  disabled={index === 0 || disabled}
                  onClick={() => go(-1)}
                  className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="min-w-[3.25rem] text-center text-[12px] tabular-nums">
                  {index + 1} of {total}
                </span>
                <button
                  type="button"
                  aria-label="Next question"
                  disabled={index >= total - 1 || disabled}
                  onClick={() => go(1)}
                  className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronRight className="size-4" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss clarifying questions"
              disabled={disabled}
              onClick={onDismiss}
              className="ml-0.5 inline-flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {current.context?.trim() ? (
          <p className="border-b border-border/50 px-3.5 py-2 text-[12px] leading-snug text-muted-foreground">
            {current.context.trim()}
          </p>
        ) : null}

        <ul className="divide-y divide-border/60">
          {current.options.map((opt, i) => {
            const selected = selectedLabel === opt.label;
            const label = opt.recommended
              ? `${opt.label} (Recommended)`
              : opt.label;
            return (
              <li key={opt.label}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => pickOption(opt)}
                  className={cn(
                    "flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors",
                    selected ? "bg-muted/70" : "hover:bg-muted/40",
                    disabled && "cursor-default opacity-60"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold tabular-nums",
                      selected
                        ? "border-foreground/25 bg-background text-foreground"
                        : "border-border bg-muted/50 text-muted-foreground"
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-[14px] leading-snug",
                        selected
                          ? "font-medium text-foreground"
                          : "text-foreground/90"
                      )}
                    >
                      {label}
                    </span>
                    {opt.description?.trim() ? (
                      <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                        {opt.description.trim()}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-2 border-t border-border/70 p-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-muted/30 px-2.5 py-1.5">
            <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={customDraft}
              disabled={disabled}
              placeholder="Something else"
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyCustom();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            {customDraft.trim() ? (
              <button
                type="button"
                disabled={disabled}
                onClick={applyCustom}
                className="shrink-0 rounded-lg bg-foreground px-2.5 py-1 text-[12px] font-medium text-background disabled:opacity-50"
              >
                Use
              </button>
            ) : null}
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={skipCurrent}
            className="shrink-0 rounded-xl border border-border bg-muted/50 px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Skip
          </button>
          {allAnswered ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSubmit(answers)}
              className="shrink-0 rounded-xl bg-foreground px-3 py-2 text-[13px] font-medium text-background disabled:opacity-50"
            >
              Submit
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Legacy single-card export — unused; dock replaces in-chat cards. */
export function ClarifyingQuestionCard() {
  return null;
}

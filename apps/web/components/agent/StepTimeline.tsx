"use client";

import type { Strings } from "../../lib/lang";

export interface TimelineStep {
  n: number;
  title: string;
  state: "done" | "current";
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
}

/**
 * The run's step timeline, fed by the SSE step events: finished steps get
 * checkmarks, the active one pulses, and the latest progress message shows
 * underneath in plain words.
 */
export function StepTimeline({
  steps,
  message,
  t,
}: {
  steps: TimelineStep[];
  message: string;
  t: Strings;
}) {
  return (
    <section
      aria-label={t.agent_steps}
      className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900"
    >
      <h2 className="text-base font-semibold text-stone-800 dark:text-stone-100">{t.agent_steps}</h2>
      {steps.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{message || t.agent_opening}</p>
      ) : (
        <ol className="mt-4 space-y-3">
          {steps.map((step) => (
            <li key={step.n} className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  step.state === "done"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : "bg-clay-soft text-clay-dark dark:bg-stone-800 dark:text-clay"
                }`}
              >
                {step.state === "done" ? (
                  <CheckIcon />
                ) : (
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-clay opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-clay" />
                  </span>
                )}
              </span>
              <p
                className={`text-[15px] ${
                  step.state === "done"
                    ? "text-stone-500 dark:text-stone-400"
                    : "font-medium text-stone-800 dark:text-stone-100"
                }`}
              >
                {step.title}
              </p>
            </li>
          ))}
        </ol>
      )}
      {message && steps.length > 0 && (
        <p className="mt-4 border-t border-stone-100 pt-3 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">
          {message}
        </p>
      )}
    </section>
  );
}

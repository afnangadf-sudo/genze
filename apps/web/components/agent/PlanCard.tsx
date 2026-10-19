"use client";

import type { AgentTask } from "../../lib/agent";
import { Button } from "../Button";
import type { Strings } from "../../lib/lang";

/**
 * The agent's plan: numbered steps, a plain estimate line
 * ("About N minutes · about $X"), and Approve / Edit / Cancel.
 * Edit = cancel this task and prefill the composer (there is no edit API).
 */
export function PlanCard({
  task,
  t,
  busy,
  onApprove,
  onCancel,
  onEdit,
}: {
  task: AgentTask;
  t: Strings;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onEdit: () => void;
}) {
  const plan = task.plan;
  if (!plan) return null;
  const estimate = t.agent_plan_estimate
    .replace("{minutes}", String(plan.estimatedMinutes))
    .replace("{cost}", plan.estimatedCostUsd.toFixed(2));
  const actionable = task.status === "planned";

  return (
    <section
      aria-label={t.agent_plan}
      className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900"
    >
      <h2 className="text-base font-semibold text-stone-800 dark:text-stone-100">{t.agent_plan}</h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{estimate}</p>
      <ol className="mt-4 space-y-3">
        {plan.steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-clay-soft text-xs font-semibold text-clay-dark dark:bg-stone-800 dark:text-clay">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-medium text-stone-800 dark:text-stone-100">{step.title}</p>
              {step.detail && (
                <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{step.detail}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {actionable && (
        <>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={onApprove} disabled={busy}>
              {t.agent_approve}
            </Button>
            <Button variant="ghost" onClick={onEdit} disabled={busy}>
              {t.agent_edit_plan}
            </Button>
            <Button variant="danger" onClick={onCancel} disabled={busy}>
              {t.agent_cancel_task}
            </Button>
          </div>
          <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">{t.agent_edit_hint}</p>
        </>
      )}
    </section>
  );
}

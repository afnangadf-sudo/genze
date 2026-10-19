"use client";

import type { AgentApproval } from "../../lib/agent";
import { Button } from "../Button";
import type { Strings } from "../../lib/lang";

/**
 * Approval gate card: the server-written summary in plain words plus a
 * what-kind label ("This will spend money", "This will delete something"…)
 * and Allow / Don't allow buttons. Nothing happens until the user decides.
 */
export function ApprovalCard({
  approval,
  t,
  busy,
  onDecide,
}: {
  approval: AgentApproval;
  t: Strings;
  busy: boolean;
  onDecide: (allow: boolean) => void;
}) {
  const kindLabel = (() => {
    switch (approval.kind) {
      case "payment":
        return t.agent_approval_payment;
      case "deletion":
        return t.agent_approval_deletion;
      case "send":
        return t.agent_approval_send;
      case "public_post":
        return t.agent_approval_public_post;
      case "form_submit":
        return t.agent_approval_form_submit;
    }
  })();

  return (
    <div
      role="dialog"
      aria-labelledby="agent-approval-title"
      className="rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-700/60 dark:bg-amber-950/30"
    >
      <h3 id="agent-approval-title" className="text-base font-semibold text-stone-800 dark:text-stone-100">
        {t.agent_approval_title}
      </h3>
      <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-300">{kindLabel}</p>
      {/* the server-written summary: exactly what the agent wants to do */}
      <p className="mt-2 text-[15px] leading-relaxed text-stone-800 dark:text-stone-100">
        {approval.summary}
      </p>
      <div className="mt-4 flex gap-2">
        <Button onClick={() => onDecide(true)} disabled={busy}>
          {t.agent_allow}
        </Button>
        <Button variant="ghost" onClick={() => onDecide(false)} disabled={busy}>
          {t.agent_dont_allow}
        </Button>
      </div>
    </div>
  );
}

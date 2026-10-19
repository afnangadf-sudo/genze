"use client";

import type { ConnectorConfirmation } from "@genze/shared";
import type { Strings } from "../../lib/lang";
import { Button } from "../Button";

/**
 * Confirmation card for connector write actions. Shows exactly what will
 * happen (the server-written plain-language summary), with Confirm / Cancel.
 * Nothing executes until the user taps Confirm.
 */
export function ConfirmationCard({
  confirmation,
  connectorName,
  busy,
  error,
  t,
  onConfirm,
  onCancel,
}: {
  confirmation: ConnectorConfirmation;
  connectorName: string;
  busy: boolean;
  error: string;
  t: Strings;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-labelledby="confirm-title"
      className="mx-auto w-full max-w-2xl rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-700/60 dark:bg-amber-950/30"
    >
      <h3
        id="confirm-title"
        className="text-base font-semibold text-stone-800 dark:text-stone-100"
      >
        {t.chat_confirm_title}
      </h3>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{connectorName}</p>
      {/* the server-written summary: exactly what the tool will do */}
      <p className="mt-3 text-[15px] leading-relaxed text-stone-800 dark:text-stone-100">
        {confirmation.summary}
      </p>
      <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{t.chat_confirm_explain}</p>
      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <div className="mt-4 flex gap-2">
        <Button onClick={onConfirm} disabled={busy}>
          {busy ? t.chat_confirm_busy : t.chat_confirm}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t.chat_cancel}
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { ConnectorAuditAction, ConnectorAuditEntry } from "@genze/shared";
import { getConnectorAudit, listConnectors, listCustomConnectors } from "../../lib/connectors";
import { useLang, type Strings } from "../../lib/lang";

function actionLabel(t: Strings, action: ConnectorAuditAction): string {
  switch (action) {
    case "connect":
      return t.c_act_connect;
    case "disconnect":
      return t.c_act_disconnect;
    case "revoke":
      return t.c_act_revoke;
    case "tool_call":
      return t.c_act_tool_call;
    case "write_confirmed":
      return t.c_act_write_confirmed;
    case "write_cancelled":
      return t.c_act_write_cancelled;
    case "token_refreshed":
      return t.c_act_token_refreshed;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AuditLogSection() {
  const { t } = useLang();
  const [entries, setEntries] = useState<ConnectorAuditEntry[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Custom connectors' audit entries carry a uuid connectorId — resolve
    // their names too, or the entry would show a bare id.
    Promise.all([getConnectorAudit(), listConnectors(), listCustomConnectors()])
      .then(([es, cs, custom]) => {
        if (cancelled) return;
        setEntries(es);
        const byId: Record<string, string> = {};
        for (const c of cs) byId[c.id] = c.name;
        for (const c of custom) byId[c.id] = c.name;
        setNames(byId);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>;
  }
  if (failed) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">{t.err_generic}</p>;
  }
  if (entries.length === 0) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">{t.c_audit_empty}</p>;
  }

  return (
    <div>
      <p className="max-w-prose text-sm text-stone-500 dark:text-stone-400">{t.c_audit_desc}</p>
      <ul className="mt-4 space-y-2">
        {entries.map((e) => (
          <li
            key={e.id}
            className="flex items-baseline justify-between gap-4 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800"
          >
            <div className="min-w-0 text-sm">
              <p className="font-medium text-stone-800 dark:text-stone-100">
                {names[e.connectorId] ?? e.connectorId}
              </p>
              <p className="mt-0.5 text-stone-500 dark:text-stone-400">{actionLabel(t, e.action)}</p>
            </div>
            <time className="shrink-0 text-xs text-stone-400 dark:text-stone-500">
              {formatDate(e.createdAt)}
            </time>
          </li>
        ))}
      </ul>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { Skill } from "@genze/shared";
import {
  attachSkillToProject,
  detachSkillFromProject,
  getProjectSkills,
  listSkills,
} from "../../lib/skills";
import { useLang } from "../../lib/lang";

/**
 * Attach-to-project UI: which skills shape this project. Reusable — mounted
 * in the Write page's per-project section (the project's editor).
 */
export function ProjectSkillsEditor({ projectId }: { projectId: string }) {
  const { t } = useLang();
  const [attached, setAttached] = useState<Skill[]>([]);
  const [all, setAll] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMsg("");
    Promise.all([getProjectSkills(projectId), listSkills()])
      .then(([as, ss]) => {
        if (!cancelled) {
          setAttached(as);
          setAll(ss);
        }
      })
      .catch(() => {
        if (!cancelled) setMsg(t.err_generic);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function attach(skillId: string) {
    setMsg("");
    setBusyId(skillId);
    try {
      await attachSkillToProject(projectId, skillId);
      const s = all.find((x) => x.id === skillId);
      if (s) setAttached((prev) => [...prev, s]);
      setMsg(t.k_attached);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  async function detach(skillId: string) {
    setMsg("");
    setBusyId(skillId);
    try {
      await detachSkillFromProject(projectId, skillId);
      setAttached((prev) => prev.filter((s) => s.id !== skillId));
      setMsg(t.k_detached);
    } catch {
      setMsg(t.err_generic);
    } finally {
      setBusyId(null);
    }
  }

  const attachedIds = new Set(attached.map((s) => s.id));
  const available = all.filter((s) => !attachedIds.has(s.id));

  return (
    <div>
      <h3 className="text-sm font-medium text-stone-700 dark:text-stone-200">
        {t.k_project_skills}
      </h3>
      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t.k_project_skills_desc}</p>
      {msg && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{msg}</p>}
      {loading ? (
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{t.s_loading}</p>
      ) : (
        <div className="mt-3">
          {attached.length === 0 && (
            <p className="text-sm text-stone-500 dark:text-stone-400">{t.k_no_skills_yet}</p>
          )}
          <ul className="flex flex-wrap gap-2">
            {attached.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-1.5 rounded-full border border-clay bg-clay-soft px-3 py-1.5 text-xs font-medium text-clay-dark dark:bg-stone-800 dark:text-clay"
              >
                <span>{s.name}</span>
                <button
                  onClick={() => detach(s.id)}
                  disabled={busyId === s.id}
                  aria-label={`${t.k_detach}: ${s.name}`}
                  title={t.k_detach}
                  className="rounded-full px-1 text-clay-dark hover:bg-clay/20 disabled:opacity-50 dark:text-clay"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {available.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-stone-500 dark:text-stone-400">{t.k_attach}:</span>
              {available.map((s) => (
                <button
                  key={s.id}
                  onClick={() => attach(s.id)}
                  disabled={busyId === s.id}
                  className="rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-600 transition-colors hover:border-clay hover:text-clay-dark disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-clay dark:hover:text-clay"
                >
                  + {s.name}
                </button>
              ))}
            </div>
          )}
          {available.length === 0 && attached.length > 0 && (
            <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">{t.k_no_more}</p>
          )}
        </div>
      )}
    </div>
  );
}

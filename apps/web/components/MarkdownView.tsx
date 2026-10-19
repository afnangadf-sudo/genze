// Small markdown renderer for reports and drafts: headings, paragraphs,
// lists, bold/italic/inline code, and clickable [n] citations that jump to
// the numbered source list below. Not a full markdown parser — enough for
// server-generated reports and drafts.

"use client";

import type { ReactNode } from "react";
import type { ResearchSource } from "@genze/shared";

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Inline formatting: **bold**, *italic*, `code`, [n] citation links. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[\d+\])/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("`")) {
      out.push(
        <code
          key={key++}
          className="rounded bg-stone-100 px-1 py-0.5 text-[0.9em] dark:bg-stone-800"
        >
          {tok.slice(1, -1)}
        </code>
      );
    } else {
      const n = tok.slice(1, -1);
      out.push(
        <a
          key={key++}
          href={`#src-${n}`}
          className="font-medium text-clay-dark underline decoration-clay/50 underline-offset-2 hover:decoration-clay dark:text-clay"
        >
          [{n}]
        </a>
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function isListItem(line: string): boolean {
  return /^\s*([-*•]|\d+[.)])\s+/.test(line);
}

function stripBullet(line: string): string {
  return line.replace(/^\s*([-*•]|\d+[.)])\s+/, "");
}

export function MarkdownView({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const cls =
        "mt-6 mb-2 font-semibold tracking-tight text-stone-800 dark:text-stone-100 " +
        (level <= 2 ? "text-lg" : "text-[15px]");
      blocks.push(
        <p key={key++} className={cls} role="heading" aria-level={level}>
          {renderInline(text)}
        </p>
      );
      i++;
      continue;
    }

    if (isListItem(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      while (i < lines.length && isListItem(lines[i])) {
        items.push(stripBullet(lines[i]));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag
          key={key++}
          className={
            "my-3 space-y-1.5 text-[15px] leading-relaxed text-stone-700 dark:text-stone-200 " +
            (ordered ? "list-decimal ps-6" : "list-disc ps-6")
          }
        >
          {items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
      continue;
    }

    // paragraph: join wrapped lines
    const para: string[] = [trimmed];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().startsWith("#") && !isListItem(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={key++} className="my-3 text-[15px] leading-relaxed text-stone-700 dark:text-stone-200">
        {renderInline(para.join(" "))}
      </p>
    );
  }

  return <div>{blocks}</div>;
}

export function SourceList({ sources }: { sources: ResearchSource[] }) {
  if (sources.length === 0) return null;
  return (
    <ol className="mt-2 space-y-3">
      {sources.map((s) => (
        <li
          key={s.n}
          id={`src-${s.n}`}
          className="scroll-mt-24 rounded-xl border border-stone-200 px-4 py-3 dark:border-stone-800"
        >
          <p className="text-sm">
            <span className="me-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-clay-soft px-1.5 text-xs font-semibold text-clay-dark dark:bg-stone-800 dark:text-clay">
              {s.n}
            </span>
            <span className="font-medium text-stone-800 dark:text-stone-100">{s.title}</span>
          </p>
          <p className="mt-1 ps-7 text-xs text-stone-500 dark:text-stone-400">{domainOf(s.url)}</p>
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block truncate ps-7 text-xs text-clay-dark underline decoration-clay/40 underline-offset-2 hover:decoration-clay dark:text-clay"
          >
            {s.url}
          </a>
        </li>
      ))}
    </ol>
  );
}

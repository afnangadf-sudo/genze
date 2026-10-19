// Citation discipline for research reports (per CONTRACTS.md Step 4).
//
// Every factual claim in the report must carry [n] matching the fetched
// source list; anything else is labeled "unverified". validateCitations()
// enforces the machine-checkable half: citation numbers in range, at least
// one citation, and the five required section headings.

export interface CitationCheck {
  ok: boolean;
  errors: string[];
}

export const REQUIRED_SECTIONS = [
  "## Summary",
  "## Key findings",
  "## Where sources disagree",
  "## Open questions",
  "## Sources",
] as const;

/** Bracketed numbers that are NOT markdown links: [3] yes, [text](url) no. */
const CITATION_RE = /\[(\d+)\](?!\s*\()/g;

export function validateCitations(markdown: string, sourceCount: number): CitationCheck {
  const errors: string[] = [];
  const text = typeof markdown === "string" ? markdown : "";

  const seen = new Set<number>();
  let match: RegExpExecArray | null;
  CITATION_RE.lastIndex = 0;
  while ((match = CITATION_RE.exec(text)) !== null) {
    const n = Number(match[1]);
    seen.add(n);
    if (n < 1 || n > sourceCount) {
      errors.push(`Citation [${n}] does not match any fetched source (1–${sourceCount}).`);
    }
  }

  if (seen.size === 0) {
    errors.push("The report contains no citations.");
  }

  for (const heading of REQUIRED_SECTIONS) {
    const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    if (!re.test(text)) {
      errors.push(`The report is missing the required section "${heading}".`);
    }
  }

  return { ok: errors.length === 0, errors };
}

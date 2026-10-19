// File exports shared by the Research and Write routes (per CONTRACTS.md
// Step 4). Real files only — docx via `docx`, PDF via `pdfkit`, xlsx via
// SheetJS (already a dependency), pptx via `pptxgenjs`. Markdown is parsed
// with a small internal block parser; inline **bold** markers are stripped
// (formatting fidelity is a v2 concern).

import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import PDFDocument from "pdfkit";
import PptxGenJSDefault from "pptxgenjs";
import * as XLSX from "xlsx";

/**
 * pptxgenjs v4's bundled types don't expose a constructable default export
 * under NodeNext, so the constructor is recovered with a cast and given a
 * structural type covering exactly the surface this module uses.
 */
interface PptxSlide {
  background: { color?: string };
  addText(text: unknown, options?: unknown): void;
}
interface PptxGenJSInstance {
  defineLayout(layout: { name: string; width: number; height: number }): void;
  layout: string;
  addSlide(): PptxSlide;
  write(props: { outputType: "nodebuffer" }): Promise<unknown>;
}
const PptxGenJS = PptxGenJSDefault as unknown as new () => PptxGenJSInstance;

export interface ExportSource {
  n: number;
  title: string;
  url: string;
}

/* ---------- tiny markdown block parser ---------- */

type BlockKind = "h1" | "h2" | "h3" | "bullet" | "number" | "para";

interface MdBlock {
  kind: BlockKind;
  text: string;
}

function stripInline(text: string): string {
  return text.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(`)(.*?)\1/g, "$2").trim();
}

function parseMarkdown(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = (md ?? "").split("\n");
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) {
      blocks.push({ kind: "para", text: stripInline(para.join(" ")) });
      para = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h1 = line.match(/^#\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h3 = line.match(/^###\s+(.*)/);
    const bullet = line.match(/^[-*•]\s+(.*)/);
    const number = line.match(/^\d+[.)]\s+(.*)/);
    if (h1) {
      flush();
      blocks.push({ kind: "h1", text: stripInline(h1[1]) });
    } else if (h2) {
      flush();
      blocks.push({ kind: "h2", text: stripInline(h2[1]) });
    } else if (h3) {
      flush();
      blocks.push({ kind: "h3", text: stripInline(h3[1]) });
    } else if (bullet) {
      flush();
      blocks.push({ kind: "bullet", text: stripInline(bullet[1]) });
    } else if (number) {
      flush();
      blocks.push({ kind: "number", text: stripInline(number[1]) });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/* ---------- citations ---------- */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MLA_MONTHS = [
  "Jan.", "Feb.", "Mar.", "Apr.", "May", "June",
  "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec.",
];

function parsedDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * APA 7th (webpage, no author/date): Title. (n.d.). Retrieved Month d, yyyy, from URL
 * MLA 9th (webpage): "Title." Accessed d Mon. yyyy. URL
 */
export function formatCitation(
  style: "apa" | "mla",
  s: { title: string; url: string; fetchedAt: string },
): string {
  const title = s.title.trim() || s.url;
  const d = parsedDate(s.fetchedAt) ?? new Date();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  if (style === "mla") {
    return `"${title}." Accessed ${day} ${MLA_MONTHS[month]} ${year}. ${s.url}`;
  }
  return `${title}. (n.d.). Retrieved ${MONTHS[month]} ${day}, ${year}, from ${s.url}`;
}

/* ---------- markdown ---------- */

export function reportToMarkdown(
  title: string,
  markdown: string,
  sources: ExportSource[],
): string {
  const lines = [`# ${title}`, "", markdown.trim(), "", "---", "", "## Sources", ""];
  for (const s of sources) {
    lines.push(`[${s.n}] ${s.title} — ${s.url}`);
  }
  return lines.join("\n") + "\n";
}

/* ---------- docx ---------- */

export async function reportToDocxBuffer(
  title: string,
  markdown: string,
  sources: ExportSource[],
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];
  for (const b of parseMarkdown(markdown)) {
    switch (b.kind) {
      case "h1":
        children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_1 }));
        break;
      case "h2":
        children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_2 }));
        break;
      case "h3":
        children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_3 }));
        break;
      case "bullet":
        children.push(new Paragraph({ text: b.text, bullet: { level: 0 } }));
        break;
      default:
        children.push(new Paragraph({ children: [new TextRun(b.text)] }));
    }
  }
  if (sources.length) {
    children.push(new Paragraph({ text: "Sources", heading: HeadingLevel.HEADING_2 }));
    for (const s of sources) {
      children.push(
        new Paragraph({ children: [new TextRun(`[${s.n}] ${s.title} — ${s.url}`)] }),
      );
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/* ---------- pdf ---------- */

export async function reportToPdfBuffer(
  title: string,
  markdown: string,
  sources: ExportSource[],
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(22).text(title, { paragraphGap: 12 });
    for (const b of parseMarkdown(markdown)) {
      switch (b.kind) {
        case "h1":
          doc.font("Helvetica-Bold").fontSize(18).text(b.text, { paragraphGap: 8 });
          break;
        case "h2":
          doc.moveDown(0.4).font("Helvetica-Bold").fontSize(15).text(b.text, { paragraphGap: 6 });
          break;
        case "h3":
          doc.font("Helvetica-Bold").fontSize(12.5).text(b.text, { paragraphGap: 4 });
          break;
        case "bullet":
          doc.font("Helvetica").fontSize(11).text(`•  ${b.text}`, { paragraphGap: 2 });
          break;
        default:
          doc.font("Helvetica").fontSize(11).text(b.text, { paragraphGap: 6 });
      }
    }
    if (sources.length) {
      doc.moveDown(0.6).font("Helvetica-Bold").fontSize(15).text("Sources", { paragraphGap: 6 });
      for (const s of sources) {
        doc.font("Helvetica").fontSize(10).text(`[${s.n}] ${s.title} — ${s.url}`, {
          paragraphGap: 3,
          link: s.url,
          underline: false,
        });
      }
    }
    doc.end();
  });
}

/* ---------- xlsx (sections table: heading / content) ---------- */

export async function draftToXlsxBuffer(title: string, markdown: string): Promise<Buffer> {
  const rows: string[][] = [["Section", "Content"]];
  let heading = title;
  let body: string[] = [];
  const flush = (): void => {
    rows.push([heading, body.join("\n").trim()]);
    body = [];
  };
  for (const b of parseMarkdown(markdown)) {
    if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3") {
      if (body.length || rows.length > 1) flush();
      heading = b.text;
    } else if (b.kind === "bullet") {
      body.push(`• ${b.text}`);
    } else {
      body.push(b.text);
    }
  }
  if (body.length || rows.length === 1) flush();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 28 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, "Draft");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

/* ---------- pptx (title + one slide per heading with bullets) ---------- */

export async function draftToPptxBuffer(title: string, markdown: string): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";

  const cover = pptx.addSlide();
  cover.background = { color: "1F2937" };
  cover.addText(title, {
    x: 0.8, y: 2.6, w: 11.7, h: 1.4,
    fontSize: 36, bold: true, color: "FFFFFF", align: "center",
  });
  cover.addText("Generated with Genze", {
    x: 0.8, y: 4.2, w: 11.7, h: 0.8,
    fontSize: 16, color: "9CA3AF", align: "center",
  });

  interface SlideDraft {
    heading: string;
    bullets: string[];
  }
  const slides: SlideDraft[] = [];
  let current: SlideDraft | null = null;
  const push = (): void => {
    if (current && (current.bullets.length > 0 || current.heading !== title)) slides.push(current);
    current = null;
  };
  for (const b of parseMarkdown(markdown)) {
    if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3") {
      push();
      current = { heading: b.text, bullets: [] };
    } else if (b.kind === "bullet" || b.kind === "number") {
      if (!current) current = { heading: title, bullets: [] };
      current.bullets.push(b.text);
    } else if (b.text) {
      if (!current) current = { heading: title, bullets: [] };
      current.bullets.push(b.text);
    }
  }
  push();

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(s.heading, {
      x: 0.7, y: 0.4, w: 11.9, h: 1.0,
      fontSize: 28, bold: true, color: "1F2937",
    });
    if (s.bullets.length) {
      slide.addText(s.bullets.map((t) => ({ text: t, options: { bullet: true } })), {
        x: 0.9, y: 1.7, w: 11.5, h: 5.2,
        fontSize: 18, color: "374151", valign: "top",
      });
    }
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

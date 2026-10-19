// i18n spot-checks for the five v1 languages.
//  1. Zero missing/extra keys: every dictionary has exactly the en key set.
//  2. langDir / LANGS registry: ur/ar/fa render rtl, en/tr ltr.
//  3. Rendering spot-check: a translated component renders per language with
//     the right `dir`, and swapping the dictionary changes the output
//     (i.e. language switching updates the UI copy).
//
// Run: pnpm test (in apps/web). Compiles lib/i18n.ts in isolation so the
// test needs no bundler; type-only imports are elided on emit.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const webDir = join(fileURLToPath(import.meta.url), "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "genze-i18n-"));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  // Compile lib/i18n.ts to plain CJS. Its only import is type-only, so we
  // feed the compiler a stub declaration to keep the test hermetic.
  const fs = await import("node:fs");
  fs.writeFileSync(
    join(tmp, "shared-stub.d.ts"),
    'declare module "@genze/shared" { export type SupportedLanguage = "en" | "ur" | "ar" | "tr" | "fa"; }\n'
  );
  execFileSync(
    "pnpm",
    ["exec", "tsc", join(webDir, "lib/i18n.ts"), join(tmp, "shared-stub.d.ts"),
     "--outDir", tmp, "--module", "commonjs",
     "--target", "es2022", "--skipLibCheck"],
    { cwd: webDir, stdio: "pipe" }
  );
  const require = createRequire(join(webDir, "package.json"));
  const { STRINGS, LANGS, langDir, isLang } = require(join(tmp, "i18n.js"));

  const codes = Object.keys(STRINGS);
  check("five languages shipped", codes.length === 5, codes.join(","));

  // 1. Key-set diff across all dictionaries.
  const enKeys = Object.keys(STRINGS.en).sort();
  for (const code of codes) {
    const keys = Object.keys(STRINGS[code]).sort();
    const missing = enKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !enKeys.includes(k));
    check(
      `${code}: zero missing/extra keys (${keys.length} keys)`,
      missing.length === 0 && extra.length === 0,
      [...missing.map((k) => `missing ${k}`), ...extra.map((k) => `extra ${k}`)].join("; ")
    );
    // No empty strings — every key has real copy.
    const empty = keys.filter((k) => STRINGS[code][k].trim().length === 0);
    check(`${code}: no empty strings`, empty.length === 0, empty.join(","));
  }

  // 2. Registry + direction.
  check(
    "LANGS registry covers all five codes",
    LANGS.map((l) => l.code).sort().join(",") === codes.sort().join(",")
  );
  const expectedRtl = { en: false, ur: true, ar: true, tr: false, fa: true };
  for (const l of LANGS) {
    check(`registry: ${l.code} rtl=${l.rtl}`, l.rtl === expectedRtl[l.code]);
    check(
      `langDir(${l.code}) = ${expectedRtl[l.code] ? "rtl" : "ltr"}`,
      langDir(l.code) === (expectedRtl[l.code] ? "rtl" : "ltr")
    );
  }
  check("isLang guards junk", isLang("en") && isLang("fa") && !isLang("de") && !isLang("") && !isLang(undefined));
  check(
    "native names",
    LANGS.map((l) => l.nativeName).join("|") === "English|اردو|العربية|Türkçe|فارسی"
  );

  // 3. Rendering spot-checks: a translated fragment per language.
  function Probe({ t, lang }) {
    return React.createElement(
      "html",
      { lang, dir: langDir(lang) },
      React.createElement(
        "body",
        null,
        React.createElement("h1", null, t.settings_title),
        React.createElement("p", null, t.chat_new),
        React.createElement("p", null, t.r_sources),
        React.createElement("p", null, t.chat_empty_title)
      )
    );
  }
  const expected = {
    en: { title: "Settings", dir: "ltr" },
    ur: { title: "ترتیبات", dir: "rtl" },
    ar: { title: "الإعدادات", dir: "rtl" },
    tr: { title: "Ayarlar", dir: "ltr" },
    fa: { title: "تنظیمات", dir: "rtl" },
  };
  const rendered = {};
  for (const code of codes) {
    const html = renderToStaticMarkup(React.createElement(Probe, { t: STRINGS[code], lang: code }));
    rendered[code] = html;
    const exp = expected[code];
    check(
      `${code}: renders with dir="${exp.dir}" and translated title`,
      html.includes(`dir="${exp.dir}"`) && html.includes(exp.title) && html.includes(`lang="${code}"`)
    );
  }
  // Switching the dictionary changes what the UI shows.
  check(
    "switching en→ar updates the rendered copy",
    rendered.en.includes("Settings") &&
      rendered.ar.includes("الإعدادات") &&
      !rendered.ar.includes("Settings</h1>")
  );
  check(
    "switching en→fa updates the rendered copy",
    rendered.fa.includes("تنظیمات") && !rendered.fa.includes("Settings</h1>")
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll i18n checks passed.");

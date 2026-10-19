// Step 9 — Video Director assembly: FFmpeg concat + audio mix + soft subtitles.
//
// Pipeline: shot MP4s (in order) -> re-encoded concat -> voiceover MP3 mixed
// with the optional user-uploaded music bed (bed at 25% volume) -> SRT added
// as a mov_text subtitle track (soft subtitles; no libass burn-in in v1).
// Output: H.264 + AAC MP4 with faststart.
//
// FFmpeg presence: /usr/bin/ffmpeg exists in this environment (verified
// 2026-10-19). FFMPEG_PATH env overrides the binary name/path. If ffmpeg is
// absent at assembly time the stage fails HONESTLY with a plain message (the
// docker image should include ffmpeg) — never a fake video.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStorage } from "../../storage/index.js";
import { StudioProviderError } from "../providers.js";

const execFileAsync = promisify(execFile);

export function ffmpegPath(): string {
  const raw = (process.env.FFMPEG_PATH ?? "").trim();
  return raw || "ffmpeg";
}

async function assertFfmpeg(): Promise<void> {
  try {
    await execFileAsync(ffmpegPath(), ["-version"]);
  } catch {
    throw new StudioProviderError(
      "PROVIDER_ERROR",
      "The video couldn't be assembled because FFmpeg isn't installed on this server. " +
        "The server image should include ffmpeg, then try again.",
    );
  }
}

export interface AssemblyInputs {
  /** Shot storage keys, in final order. */
  shotKeys: string[];
  /** Voiceover MP3 storage key. */
  voiceoverKey: string;
  /** Optional user-uploaded music bed storage key. */
  musicKey: string | null;
  /** Captions SRT storage key (or null). */
  srtKey: string | null;
}

export interface AssemblyOutput {
  /** Storage key of the finished MP4. */
  storageKey: string;
  /** Seconds of finished video (sum of shot durations). */
  totalSeconds: number;
}

/** Test seam: override the real FFmpeg assembly (tests have no real clips). */
let assemblyOverride: ((inputs: AssemblyInputs) => Promise<AssemblyOutput>) | null = null;
export function __setAssemblyOverride(
  fn: ((inputs: AssemblyInputs) => Promise<AssemblyOutput>) | null,
): void {
  assemblyOverride = fn;
}

export async function assembleVideo(
  inputs: AssemblyInputs,
  shotDurations: number[],
): Promise<AssemblyOutput> {
  if (assemblyOverride) return assemblyOverride(inputs);
  await assertFfmpeg();

  const workdir = await mkdtemp(join(tmpdir(), "genze-video-"));
  try {
    // Materialize inputs.
    const shotFiles: string[] = [];
    for (let i = 0; i < inputs.shotKeys.length; i++) {
      const bytes = await getStorage().get(inputs.shotKeys[i]);
      const f = join(workdir, `shot${i}.mp4`);
      await writeFile(f, bytes);
      shotFiles.push(f);
    }
    const voiceFile = join(workdir, "voiceover.mp3");
    await writeFile(voiceFile, await getStorage().get(inputs.voiceoverKey));
    let musicFile: string | null = null;
    if (inputs.musicKey) {
      musicFile = join(workdir, "music.audio");
      await writeFile(musicFile, await getStorage().get(inputs.musicKey));
    }
    let srtFile: string | null = null;
    if (inputs.srtKey) {
      srtFile = join(workdir, "captions.srt");
      await writeFile(srtFile, await getStorage().get(inputs.srtKey));
    }

    // Input indices: 0..N-1 shots, N voiceover, N+1 music?, N+2 srt?
    const args: string[] = ["-y"];
    for (const f of shotFiles) args.push("-i", f);
    const voiceIdx = shotFiles.length;
    args.push("-i", voiceFile);
    let musicIdx = -1;
    if (musicFile) {
      musicIdx = voiceIdx + 1;
      args.push("-i", musicFile);
    }
    let srtIdx = -1;
    if (srtFile) {
      srtIdx = musicIdx === -1 ? voiceIdx + 1 : voiceIdx + 2;
      args.push("-i", srtFile);
    }

    const n = shotFiles.length;
    const vIns = Array.from({ length: n }, (_, i) => `[${i}:v]`).join("");
    const filters: string[] = [`${vIns}concat=n=${n}:v=1:a=0[vcat]`];
    let audioLabel: string;
    if (musicIdx !== -1) {
      filters.push(`[${musicIdx}:a]volume=0.25[mus]`);
      filters.push(`[${voiceIdx}:a][mus]amix=inputs=2:duration=first[aout]`);
      audioLabel = "[aout]";
    } else {
      audioLabel = `[${voiceIdx}:a]`;
    }
    args.push("-filter_complex", filters.join(";"));
    args.push("-map", "[vcat]", "-map", audioLabel);
    if (srtIdx !== -1) args.push("-map", `${srtIdx}`);
    args.push(
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "20",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
    );
    if (srtIdx !== -1) args.push("-c:s", "mov_text");
    args.push("-movflags", "+faststart");
    const outFile = join(workdir, "final.mp4");
    args.push(outFile);

    await execFileAsync(ffmpegPath(), args, { timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });

    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(outFile);
    const storageKey = `studio/video/${workdir.split("/").pop()}-final.mp4`;
    await getStorage().put(storageKey, bytes);
    return { storageKey, totalSeconds: shotDurations.reduce((a, b) => a + b, 0) };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Concatenate MP3 chunks (TTS segments). FFmpeg concat demuxer when
 *  available, plain Buffer.concat fallback (MP3 frames join cleanly). */
export async function concatMp3(chunks: Buffer[]): Promise<Buffer> {
  if (chunks.length === 1) return chunks[0];
  try {
    await assertFfmpeg();
    const workdir = await mkdtemp(join(tmpdir(), "genze-tts-"));
    try {
      const files: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const f = join(workdir, `part${i}.mp3`);
        await writeFile(f, chunks[i]);
        files.push(f);
      }
      const listFile = join(workdir, "list.txt");
      await writeFile(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
      const out = join(workdir, "joined.mp3");
      await execFileAsync(ffmpegPath(), ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", out]);
      const { readFile } = await import("node:fs/promises");
      return await readFile(out);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  } catch {
    return Buffer.concat(chunks);
  }
}

/* ---------------- captions (SRT) ---------------- */

/** Split narration into caption sentences. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function srtTime(totalSeconds: number): string {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(rest, 3)}`;
}

/**
 * Build a real SRT from narration segments, timed proportionally to the
 * voiceover length (chars/14 per second heuristic). No invented timings
 * beyond the proportional split — the file is honest captioning.
 */
export function buildSrt(segments: string[], totalSeconds: number): string {
  const totalChars = segments.reduce((a, s) => a + s.length, 0) || 1;
  let cursor = 0;
  const out: string[] = [];
  segments.forEach((seg, i) => {
    const dur = Math.max(0.8, (seg.length / totalChars) * totalSeconds);
    const start = cursor;
    const end = i === segments.length - 1 ? totalSeconds : cursor + dur;
    out.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${seg}\n`);
    cursor = end;
  });
  return out.join("\n");
}

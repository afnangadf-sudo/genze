"use client";

/**
 * Studio tab (Step 9): Images, Voice, Video Director, Audio Overviews.
 *
 * All copy lives in lib/i18n.ts (st_* keys, 5 languages). Layouts use
 * logical Tailwind utilities only (RTL-safe). Errors are inline messages,
 * never pop-ups. Media plays from signed URLs — raw bytes never sit in
 * state.
 */

import { useEffect, useRef, useState } from "react";
import {
  COMMON_LANGUAGES,
  LANGUAGE_NAMES,
  STUDIO_VIDEO_STAGE_IDS,
  type AudioOverview,
  type AudioOverviewLength,
  type GenzeFile,
  type StudioImage,
  type StudioVideo,
  type StudioVideoStageId,
} from "@genze/shared";
import { TabShell } from "../../components/TabShell";
import { ConsentGate } from "../../components/ConsentGate";
import { Button } from "../../components/Button";
import { Field, fieldInputClass } from "../../components/Field";
import { useLang, type Strings } from "../../lib/lang";
import { ApiClientError } from "../../lib/auth";
import { listFiles } from "../../lib/files";
import {
  approveVideo,
  createAudioOverview,
  createVideo,
  deleteShot,
  deleteVideo,
  editImage,
  generateImage,
  getAudioOverview,
  getImage,
  getVideo,
  listAudioOverviews,
  listImages,
  listVideos,
  reorderShots,
  regenerateShot,
  signedUrl,
  speakText,
  subscribeStudioVideo,
  transcribeAudio,
} from "../../lib/studio";

const fill = (s: string, n: number | string) => s.replace("{n}", String(n));

function errText(t: Strings, err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return t.err_generic;
}

function isNotConfigured(err: unknown): boolean {
  return err instanceof ApiClientError && err.code === "NOT_CONFIGURED";
}

/** Poll a getter until the predicate holds (2 s cadence, bounded). */
async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  tries = 45
): Promise<T> {
  let last = await fn();
  for (let i = 0; i < tries && !done(last); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    last = await fn();
  }
  return last;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 first:mt-8">
      <h2 className="text-xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function InlineError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="mt-2 text-sm text-red-700 dark:text-red-400">{message}</p>;
}

function InlineNote({ message }: { message: string }) {
  if (!message) return null;
  return <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{message}</p>;
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ================= images ================= */

const ASPECTS = ["square", "wide", "tall"] as const;
type Aspect = (typeof ASPECTS)[number];

function aspectLabel(t: Strings, a: Aspect): string {
  if (a === "square") return t.st_images_shape_square;
  if (a === "wide") return t.st_images_shape_wide;
  return t.st_images_shape_tall;
}

function ImagesSection() {
  const { t } = useLang();
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<Aspect>("square");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const [images, setImages] = useState<StudioImage[]>([]);
  const [enlarged, setEnlarged] = useState<StudioImage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    listImages()
      .then((list) => {
        if (!cancelled) setImages(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isNotConfigured(err)) setNotConfigured(true);
        else setError(errText(t, err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleGenerate() {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const created = await generateImage(p, aspect);
      setImages((prev) => [created, ...prev]);
      setPrompt("");
      if (created.status === "pending") {
        const final = await pollUntil(
          () => getImage(created.id),
          (img) => img.status !== "pending"
        );
        setImages((prev) => prev.map((img) => (img.id === final.id ? final : img)));
      }
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setError(errText(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function handleEdit(id: string) {
    const p = editPrompt.trim();
    if (!p || editBusy) return;
    setEditBusy(true);
    setError("");
    try {
      const created = await editImage(id, p);
      setImages((prev) => [created, ...prev]);
      setEditingId(null);
      setEditPrompt("");
      setNote(t.st_images_edited);
      if (created.status === "pending") {
        const final = await pollUntil(
          () => getImage(created.id),
          (img) => img.status !== "pending"
        );
        setImages((prev) => prev.map((img) => (img.id === final.id ? final : img)));
      }
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setError(errText(t, err));
    } finally {
      setEditBusy(false);
    }
  }

  if (notConfigured) {
    return (
      <Section title={t.st_section_images}>
        <p className="text-[15px] text-stone-500 dark:text-stone-400">{t.st_images_not_configured}</p>
      </Section>
    );
  }

  return (
    <Section title={t.st_section_images}>
      <p className="text-[15px] text-stone-500 dark:text-stone-400">{t.st_images_desc}</p>
      <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t.st_images_prompt_ph}
          aria-label={t.st_images_prompt_ph}
          className="min-h-[72px] w-full resize-none rounded-xl border border-stone-300 bg-white px-4 py-3 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:placeholder:text-stone-500"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-stone-600 dark:text-stone-300">
            {t.st_images_shape}:
          </span>
          <div className="flex gap-1.5" role="radiogroup" aria-label={t.st_images_shape}>
            {ASPECTS.map((a) => (
              <button
                key={a}
                role="radio"
                aria-checked={aspect === a}
                onClick={() => setAspect(a)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  aspect === a
                    ? "border-clay bg-clay-soft text-clay-dark dark:bg-stone-800 dark:text-clay"
                    : "border-stone-300 text-stone-500 hover:border-clay hover:text-clay-dark dark:border-stone-700 dark:text-stone-400 dark:hover:border-clay dark:hover:text-clay"
                }`}
              >
                {aspectLabel(t, a)}
              </button>
            ))}
          </div>
          <span className="ms-auto">
            <Button onClick={handleGenerate} disabled={busy || !prompt.trim()}>
              {busy ? t.st_images_generating : t.st_images_generate}
            </Button>
          </span>
        </div>
        <InlineError message={error} />
        <InlineNote message={note} />
      </div>

      <h3 className="mt-8 text-base font-semibold text-stone-800 dark:text-stone-100">
        {t.st_images_yours}
      </h3>
      {images.length === 0 ? (
        <p className="mt-2 text-[15px] text-stone-500 dark:text-stone-400">{t.st_images_empty}</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {images.map((img) => (
            <figure
              key={img.id}
              className="overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
            >
              <button
                onClick={() => img.imageUrl && setEnlarged(img)}
                aria-label={t.st_images_enlarge}
                className="block w-full"
                disabled={!img.imageUrl}
              >
                {img.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={signedUrl(img.imageUrl)}
                    alt={img.prompt}
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center bg-stone-100 text-sm text-stone-400 dark:bg-stone-800 dark:text-stone-500">
                    {t.st_images_generating}
                  </div>
                )}
              </button>
              <figcaption className="p-3">
                <p className="line-clamp-2 text-xs text-stone-500 dark:text-stone-400">{img.prompt}</p>
                <div className="mt-2">
                  {editingId === img.id ? (
                    <div>
                      <input
                        value={editPrompt}
                        onChange={(e) => setEditPrompt(e.target.value)}
                        placeholder={t.st_images_edit_ph}
                        aria-label={t.st_images_edit_ph}
                        className={fieldInputClass}
                      />
                      <div className="mt-2 flex gap-2">
                        <Button
                          onClick={() => handleEdit(img.id)}
                          disabled={editBusy || !editPrompt.trim()}
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          {editBusy ? t.st_images_generating : t.st_images_apply}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditingId(null);
                            setEditPrompt("");
                          }}
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          {t.st_images_close}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditingId(img.id);
                        setEditPrompt("");
                      }}
                      disabled={!img.imageUrl}
                      className="!px-3 !py-1.5 !text-xs"
                    >
                      {t.st_images_edit}
                    </Button>
                  )}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {/* enlarged view — an inline overlay, not a pop-up window */}
      {enlarged?.imageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setEnlarged(null)}
          role="dialog"
          aria-label={t.st_images_enlarge}
        >
          <div
            className="max-h-full max-w-3xl overflow-hidden rounded-2xl bg-white dark:bg-stone-900"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={signedUrl(enlarged.imageUrl)} alt={enlarged.prompt} className="max-h-[80vh] w-auto" />
            <div className="flex items-center justify-between gap-4 p-4">
              <p className="line-clamp-2 text-sm text-stone-500 dark:text-stone-400">{enlarged.prompt}</p>
              <Button variant="ghost" onClick={() => setEnlarged(null)}>
                {t.st_images_close}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

/* ================= voice ================= */

function VoiceSection() {
  const { t, lang } = useLang();
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("");
  const [speakBusy, setSpeakBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [transcribeBusy, setTranscribeBusy] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Common languages for the datalist — any BCP-47 code is accepted.
  const languageOptions = [...Object.entries(LANGUAGE_NAMES), ...Object.entries(COMMON_LANGUAGES)];

  async function handleSpeak() {
    const body = text.trim();
    if (!body || speakBusy) return;
    setSpeakBusy(true);
    setError("");
    try {
      const url = await speakText(body, language.trim() || lang);
      setAudioUrl(url);
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setError(errText(t, err));
    } finally {
      setSpeakBusy(false);
    }
  }

  async function handleTranscribe() {
    if (!file || transcribeBusy) return;
    setTranscribeBusy(true);
    setError("");
    setTranscript("");
    try {
      const result = await transcribeAudio(file);
      setTranscript(result.text);
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setError(errText(t, err));
    } finally {
      setTranscribeBusy(false);
    }
  }

  if (notConfigured) {
    return (
      <Section title={t.st_section_voice}>
        <p className="text-[15px] text-stone-500 dark:text-stone-400">{t.st_voice_not_configured}</p>
      </Section>
    );
  }

  return (
    <Section title={t.st_section_voice}>
      <div className="grid gap-4 md:grid-cols-2">
        {/* text to speech */}
        <div className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <h3 className="text-base font-semibold text-stone-800 dark:text-stone-100">
            {t.st_voice_tts_title}
          </h3>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t.st_voice_tts_desc}</p>
          <textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t.st_voice_text_ph}
            aria-label={t.st_voice_text_ph}
            className="mt-3 min-h-[96px] w-full resize-none rounded-xl border border-stone-300 bg-white px-4 py-3 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:placeholder:text-stone-500"
          />
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[10rem] flex-1">
              <Field
                id="st-voice-lang"
                label={t.st_voice_language}
                list="st-voice-langs"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder={t.st_voice_language_ph}
              />
              <datalist id="st-voice-langs">
                {languageOptions.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </datalist>
            </div>
            <Button onClick={handleSpeak} disabled={speakBusy || !text.trim()}>
              {speakBusy ? t.st_voice_speaking : t.st_voice_speak}
            </Button>
          </div>
          {audioUrl && (
            <audio controls src={audioUrl} className="mt-4 w-full">
              {t.st_voice_tts_title}
            </audio>
          )}
        </div>

        {/* speech to text */}
        <div className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <h3 className="text-base font-semibold text-stone-800 dark:text-stone-100">
            {t.st_voice_transcribe_title}
          </h3>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            {t.st_voice_transcribe_desc}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setTranscript("");
              }}
            />
            <Button variant="ghost" onClick={() => fileInputRef.current?.click()}>
              {t.st_voice_choose}
            </Button>
            {file && (
              <span className="max-w-[14rem] truncate text-sm text-stone-500 dark:text-stone-400">
                {file.name}
              </span>
            )}
            <Button onClick={handleTranscribe} disabled={transcribeBusy || !file}>
              {transcribeBusy ? t.st_voice_transcribing : t.st_voice_transcribe_title}
            </Button>
          </div>
          {transcript && (
            <div className="mt-4">
              <p className="text-sm font-medium text-stone-600 dark:text-stone-300">
                {t.st_voice_transcript}
              </p>
              <p className="mt-1 whitespace-pre-wrap rounded-xl bg-stone-50 p-3 text-[15px] leading-relaxed text-stone-800 dark:bg-stone-800 dark:text-stone-100">
                {transcript}
              </p>
            </div>
          )}
        </div>
      </div>
      <InlineError message={error} />
    </Section>
  );
}

/* ================= video director ================= */

function stageName(t: Strings, id: StudioVideoStageId): string {
  switch (id) {
    case "idea":
      return t.st_video_stage_idea;
    case "script":
      return t.st_video_stage_script;
    case "storyboard":
      return t.st_video_stage_storyboard;
    case "shots":
      return t.st_video_stage_shots;
    case "voiceover":
      return t.st_video_stage_voiceover;
    case "music":
      return t.st_video_stage_music;
    case "captions":
      return t.st_video_stage_captions;
    case "assembly":
      return t.st_video_stage_assembly;
  }
}

function VideoSection() {
  const { t } = useLang();
  const [videos, setVideos] = useState<StudioVideo[]>([]);
  const [active, setActive] = useState<StudioVideo | null>(null);
  const [brief, setBrief] = useState("");
  const [length, setLength] = useState("5");
  const [creating, setCreating] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const [discarded, setDiscarded] = useState<string[]>([]);
  const [shotBusy, setShotBusy] = useState<string | null>(null);

  const refreshList = async () => {
    try {
      setVideos(await listVideos());
    } catch {
      /* list failures stay quiet — the main actions surface their own errors */
    }
  };

  // On load: pick up a video that is already being made and watch it live.
  useEffect(() => {
    let cancelled = false;
    listVideos()
      .then((list) => {
        if (cancelled) return;
        setVideos(list);
        const running = list.find((v) => v.status === "running");
        if (running) setActive(running);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isNotConfigured(err)) setNotConfigured(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live progress while the active video is being made (SSE + polling fallback).
  useEffect(() => {
    if (!active || active.status !== "running") return;
    const stop = subscribeStudioVideo(active.id, {
      onProgress: (ev) => {
        setActive((prev) => {
          if (!prev) return prev;
          const at = STUDIO_VIDEO_STAGE_IDS.indexOf(ev.stage);
          const pct = ev.total > 0 ? Math.round((ev.done / ev.total) * 100) : 0;
          return {
            ...prev,
            stages: STUDIO_VIDEO_STAGE_IDS.map((id, i) => {
              const old = prev.stages.find((s) => s.id === id);
              if (i < at) return { id, status: "done", progress: 100 };
              if (i === at)
                return {
                  id,
                  status: "running",
                  progress: ev.done >= ev.total ? 100 : pct,
                };
              return old ?? { id, status: "waiting", progress: 0 };
            }),
          };
        });
      },
      onShot: (ev) => {
        setActive((prev) => {
          if (!prev) return prev;
          const shots = prev.shots.some((s) => s.id === ev.shot.id)
            ? prev.shots.map((s) => (s.id === ev.shot.id ? ev.shot : s))
            : [...prev.shots, ev.shot];
          return { ...prev, shots };
        });
      },
      onTerminal: (video) => {
        setActive(video);
        void refreshList();
      },
      onError: (err) => setError(errText(t, err)),
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.status === "running"]);

  async function handleCreate() {
    const b = brief.trim();
    const mins = Math.min(15, Math.max(1, parseInt(length, 10) || 5));
    if (!b || creating) return;
    setCreating(true);
    setEstimating(true);
    setError("");
    try {
      const created = await createVideo(b, mins);
      setBrief("");
      // Wait for the estimate — nothing is made until the user approves it.
      const withEstimate = await pollUntil(
        () => getVideo(created.id),
        (v) => v.status !== "estimating"
      );
      setActive(withEstimate);
      await refreshList();
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setError(errText(t, err));
    } finally {
      setCreating(false);
      setEstimating(false);
    }
  }

  async function handleApprove() {
    if (!active || approving) return;
    setApproving(true);
    setError("");
    try {
      const started = await approveVideo(active.id);
      setActive(started);
    } catch (err) {
      setError(errText(t, err));
    } finally {
      setApproving(false);
    }
  }

  async function handleDiscard() {
    if (!active) return;
    // The approval gate is sacred: without approve, nothing was made.
    // Discarding deletes the unapproved plan server-side so abandoned
    // estimates don't pile up.
    try {
      await deleteVideo(active.id);
    } catch {
      // Fall through to client-side hiding even if the delete fails.
    }
    setDiscarded((prev) => [...prev, active.id]);
    setActive(null);
  }

  async function handleShotOp(op: () => Promise<StudioVideo>, shotId: string) {
    if (shotBusy) return;
    setShotBusy(shotId);
    setError("");
    try {
      const updated = await op();
      setActive(updated);
    } catch (err) {
      setError(errText(t, err));
    } finally {
      setShotBusy(null);
    }
  }

  const visibleVideos = videos.filter((v) => !discarded.includes(v.id));
  const est = active?.estimate ?? null;

  if (notConfigured) {
    return (
      <Section title={t.st_section_video}>
        <p className="text-[15px] text-stone-500 dark:text-stone-400">{t.st_video_not_configured}</p>
      </Section>
    );
  }

  return (
    <Section title={t.st_section_video}>
      <p className="text-[15px] text-stone-500 dark:text-stone-400">{t.st_video_desc}</p>

      {/* new video */}
      {!active && (
        <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <h3 className="text-base font-semibold text-stone-800 dark:text-stone-100">
            {t.st_video_new}
          </h3>
          <textarea
            rows={3}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={t.st_video_brief_ph}
            aria-label={t.st_video_brief_ph}
            className="mt-3 min-h-[72px] w-full resize-none rounded-xl border border-stone-300 bg-white px-4 py-3 text-[15px] text-stone-800 placeholder:text-stone-400 focus:border-clay focus:outline-none focus:ring-1 focus:ring-clay dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:placeholder:text-stone-500"
          />
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field
                id="st-video-length"
                label={t.st_video_length}
                type="number"
                min={1}
                max={15}
                value={length}
                onChange={(e) => setLength(e.target.value)}
              />
            </div>
            <Button onClick={handleCreate} disabled={creating || !brief.trim()}>
              {estimating ? t.st_video_planning : t.st_video_plan}
            </Button>
          </div>
          <InlineError message={error} />
        </div>
      )}

      {/* the plan — approval gate. Generation never starts without Approve. */}
      {active && active.status === "awaiting_approval" && est && (
        <div
          role="dialog"
          aria-label={t.st_video_waiting_approval}
          className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-700/60 dark:bg-amber-950/30"
        >
          <h3 className="text-base font-semibold text-stone-800 dark:text-stone-100">
            {t.st_video_waiting_approval}
          </h3>
          <p className="mt-1 line-clamp-2 text-sm text-stone-500 dark:text-stone-400">
            {active.brief}
          </p>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-white/70 p-3 dark:bg-stone-900/60">
              <dt className="text-xs text-stone-500 dark:text-stone-400">
                {t.st_video_estimate_cost}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-stone-800 dark:text-stone-100">
                ${est.costUsd.toFixed(2)}
              </dd>
            </div>
            <div className="rounded-xl bg-white/70 p-3 dark:bg-stone-900/60">
              <dt className="text-xs text-stone-500 dark:text-stone-400">
                {t.st_video_estimate_length}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-stone-800 dark:text-stone-100">
                {formatClock(est.totalSeconds)}
              </dd>
            </div>
            <div className="rounded-xl bg-white/70 p-3 dark:bg-stone-900/60">
              <dt className="text-xs text-stone-500 dark:text-stone-400">
                {t.st_video_estimate_time}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-stone-800 dark:text-stone-100">
                {fill(t.st_video_estimate_minutes, est.estimatedMinutes)}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex gap-2">
            <Button onClick={handleApprove} disabled={approving}>
              {approving ? t.st_video_approving : t.st_video_approve}
            </Button>
            <Button variant="ghost" onClick={handleDiscard} disabled={approving}>
              {t.st_video_discard}
            </Button>
          </div>
          <InlineError message={error} />
        </div>
      )}

      {/* making / made */}
      {active && (active.status === "running" || active.status === "done" || active.status === "failed") && (
        <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
          <div className="flex items-center justify-between gap-3">
            <h3 className="line-clamp-1 text-base font-semibold text-stone-800 dark:text-stone-100">
              {active.brief}
            </h3>
            <Button
              variant="ghost"
              onClick={() => setActive(null)}
              className="!px-3 !py-1.5 !text-xs"
            >
              {t.st_video_new}
            </Button>
          </div>

          {active.status === "failed" && (
            <p className="mt-2 text-sm text-red-700 dark:text-red-400">{t.st_video_failed}</p>
          )}

          {/* stage timeline */}
          <h4 className="mt-4 text-sm font-medium text-stone-600 dark:text-stone-300">
            {t.st_video_progress}
          </h4>
          <ol className="mt-2 space-y-2">
            {STUDIO_VIDEO_STAGE_IDS.map((id) => {
              const stage = active.stages.find((s) => s.id === id) ?? {
                id,
                status: "waiting",
                progress: 0,
              };
              const dot =
                stage.status === "done"
                  ? "bg-green-500"
                  : stage.status === "running"
                    ? "bg-clay"
                    : stage.status === "failed"
                      ? "bg-red-500"
                      : "bg-stone-300 dark:bg-stone-700";
              return (
                <li key={id} className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
                  <span className="w-28 shrink-0 text-sm text-stone-600 dark:text-stone-300">
                    {stageName(t, id)}
                  </span>
                  <span className="flex h-1.5 flex-1 justify-start overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
                    <span
                      className={`h-full rounded-full ${stage.status === "failed" ? "bg-red-500" : "bg-clay"}`}
                      style={{ width: `${stage.status === "done" ? 100 : stage.progress}%` }}
                    />
                  </span>
                </li>
              );
            })}
          </ol>

          {/* finished video — the one completion note */}
          {active.status === "done" && active.videoUrl && (
            <div className="mt-5">
              <h4 className="text-sm font-medium text-stone-600 dark:text-stone-300">
                {t.st_video_final}
              </h4>
              <video controls src={signedUrl(active.videoUrl)} className="mt-2 w-full rounded-xl" />
              <a
                href={signedUrl(active.videoUrl)}
                download
                className="mt-2 inline-block rounded-lg bg-clay px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-clay-dark"
              >
                {t.st_video_download}
              </a>
            </div>
          )}

          {/* scenes */}
          {active.shots.length > 0 && (
            <div className="mt-5">
              <h4 className="text-sm font-medium text-stone-600 dark:text-stone-300">
                {t.st_video_scenes}
              </h4>
              <ul className="mt-2 space-y-3">
                {[...active.shots]
                  .sort((a, b) => a.order - b.order)
                  .map((shot, i, sorted) => (
                    <li
                      key={shot.id}
                      className="rounded-xl border border-stone-200 p-4 dark:border-stone-800"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="flex-1 text-sm leading-relaxed text-stone-700 dark:text-stone-200">
                          <span className="me-2 font-semibold text-stone-400 dark:text-stone-500">
                            {i + 1}
                          </span>
                          {shot.prompt}
                        </p>
                        <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">
                          {fill(t.st_video_seconds, shot.durationSeconds)}
                        </span>
                      </div>
                      {shot.previewUrl && (
                        <video
                          controls
                          src={signedUrl(shot.previewUrl)}
                          className="mt-3 max-h-48 w-full rounded-lg"
                        />
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          disabled={shotBusy !== null}
                          onClick={() =>
                            handleShotOp(() => regenerateShot(active.id, shot.id), shot.id)
                          }
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          {shotBusy === shot.id ? t.st_video_remaking : t.st_video_remake}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={shotBusy !== null || i === 0}
                          onClick={() => {
                            const order = sorted.map((s) => s.id);
                            [order[i - 1], order[i]] = [order[i], order[i - 1]];
                            return handleShotOp(
                              () => reorderShots(active.id, shot.id, order),
                              shot.id
                            );
                          }}
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          {t.st_video_move_up}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={shotBusy !== null || i === sorted.length - 1}
                          onClick={() => {
                            const order = sorted.map((s) => s.id);
                            [order[i], order[i + 1]] = [order[i + 1], order[i]];
                            return handleShotOp(
                              () => reorderShots(active.id, shot.id, order),
                              shot.id
                            );
                          }}
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          {t.st_video_move_down}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={shotBusy !== null}
                          onClick={() => handleShotOp(() => deleteShot(active.id, shot.id), shot.id)}
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          {t.st_video_delete_scene}
                        </Button>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <InlineError message={error} />
        </div>
      )}

      {/* past videos */}
      {visibleVideos.length > 0 && (
        <div className="mt-6">
          <h3 className="text-base font-semibold text-stone-800 dark:text-stone-100">
            {t.st_section_video}
          </h3>
          <ul className="mt-2 space-y-2">
            {visibleVideos.map((v) => (
              <li key={v.id}>
                <button
                  onClick={() => setActive(v)}
                  className={`block w-full rounded-xl border p-3 text-start transition-colors ${
                    active?.id === v.id
                      ? "border-clay bg-clay-soft dark:bg-stone-800"
                      : "border-stone-200 bg-white hover:border-clay dark:border-stone-800 dark:bg-stone-900"
                  }`}
                >
                  <span className="line-clamp-1 text-sm font-medium text-stone-800 dark:text-stone-100">
                    {v.brief}
                  </span>
                  <span className="mt-0.5 block text-xs text-stone-400 dark:text-stone-500">
                    {v.status === "awaiting_approval"
                      ? t.st_video_waiting_approval
                      : v.status === "done"
                        ? t.st_video_final
                        : v.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {visibleVideos.length === 0 && !active && (
        <p className="mt-6 text-[15px] text-stone-500 dark:text-stone-400">{t.st_video_empty}</p>
      )}
    </Section>
  );
}

/* ================= audio overviews ================= */

const OVERVIEW_LENGTHS: AudioOverviewLength[] = ["short", "medium", "long"];

function overviewLengthLabel(t: Strings, l: AudioOverviewLength): string {
  if (l === "short") return t.st_overview_short;
  if (l === "medium") return t.st_overview_medium;
  return t.st_overview_long;
}

function OverviewsSection() {
  const { t } = useLang();
  const [files, setFiles] = useState<GenzeFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [length, setLength] = useState<AudioOverviewLength>("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const [overviews, setOverviews] = useState<AudioOverview[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listFiles(), listAudioOverviews()])
      .then(([fileList, ovList]) => {
        if (cancelled) return;
        setFiles(fileList);
        setOverviews(ovList);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isNotConfigured(err)) setNotConfigured(true);
        else setError(errText(t, err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleFile(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleGenerate() {
    if (selected.length === 0) {
      setError(t.st_overview_pick_first);
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await createAudioOverview(selected, length);
      setOverviews((prev) => [created, ...prev]);
      setSelected([]);
      if (created.status === "pending") {
        const final = await pollUntil(
          () => getAudioOverview(created.id),
          (ov) => ov.status !== "pending"
        );
        setOverviews((prev) => prev.map((ov) => (ov.id === final.id ? final : ov)));
      }
    } catch (err) {
      if (isNotConfigured(err)) setNotConfigured(true);
      else setError(errText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (notConfigured) {
    return (
      <Section title={t.st_section_overviews}>
        <p className="text-[15px] text-stone-500 dark:text-stone-400">
          {t.st_overview_not_configured}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t.st_section_overviews}>
      <p className="text-[15px] text-stone-500 dark:text-stone-400">{t.st_overview_desc}</p>
      <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
        <p className="text-sm font-medium text-stone-600 dark:text-stone-300">
          {t.st_overview_files}
        </p>
        {files.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{t.st_overview_empty}</p>
        ) : (
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
            {files.map((f) => {
              const on = selected.includes(f.id);
              return (
                <li key={f.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleFile(f.id)}
                      className="h-4 w-4 shrink-0 accent-stone-700 dark:accent-stone-300"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-stone-700 dark:text-stone-200">
                      {f.originalName}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-stone-600 dark:text-stone-300">
            {t.st_overview_length}:
          </span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t.st_overview_length}>
            {OVERVIEW_LENGTHS.map((l) => (
              <button
                key={l}
                role="radio"
                aria-checked={length === l}
                onClick={() => setLength(l)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  length === l
                    ? "border-clay bg-clay-soft text-clay-dark dark:bg-stone-800 dark:text-clay"
                    : "border-stone-300 text-stone-500 hover:border-clay hover:text-clay-dark dark:border-stone-700 dark:text-stone-400 dark:hover:border-clay dark:hover:text-clay"
                }`}
              >
                {overviewLengthLabel(t, l)}
              </button>
            ))}
          </div>
          <span className="ms-auto">
            <Button onClick={handleGenerate} disabled={busy}>
              {busy ? t.st_overview_generating : t.st_overview_generate}
            </Button>
          </span>
        </div>
        <InlineError message={error} />
      </div>

      {overviews.length > 0 && (
        <ul className="mt-4 space-y-3">
          {overviews.map((ov) => (
            <li
              key={ov.id}
              className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="line-clamp-1 text-sm font-medium text-stone-800 dark:text-stone-100">
                  {ov.title}
                </p>
                <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">
                  {overviewLengthLabel(t, ov.length)}
                </span>
              </div>
              {ov.status === "ready" && ov.audioUrl ? (
                <audio controls src={signedUrl(ov.audioUrl)} className="mt-2 w-full" />
              ) : (
                <p className="mt-2 text-sm text-stone-400 dark:text-stone-500">
                  {t.st_overview_generating}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* ================= page ================= */

export default function StudioPage() {
  const { t } = useLang();
  return (
    <TabShell wide>
      <ConsentGate>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-800 dark:text-stone-100">
          {t.tab_studio}
        </h1>
        <ImagesSection />
        <VoiceSection />
        <VideoSection />
        <OverviewsSection />
      </ConsentGate>
    </TabShell>
  );
}

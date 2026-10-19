// @genze/shared — types and route constants shared by apps/web and apps/api.
// The API contract lives in ../../CONTRACTS.md; this file mirrors it in types.

export type PlanType = "free" | "paid";

/* Step 4 multilingual v1: the five fully-translated UI languages.
   (User correction 2026-10-18: chat/translate/voice accept ANY language —
   see COMMON_LANGUAGES / languageDisplayName / isValidLanguageCode below.) */
export type SupportedLanguage = "en" | "ur" | "ar" | "tr" | "fa";

/** Native display names for the language picker. */
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  ur: "اردو",
  ar: "العربية",
  tr: "Türkçe",
  fa: "فارسی",
};

/** Languages rendered right-to-left. */
export const RTL_LANGUAGES: SupportedLanguage[] = ["ur", "ar", "fa"];

/**
 * Native display names for common chat/translate languages beyond the five
 * fully-translated UI languages. Keyed by lowercase BCP-47 primary code.
 * This table is a convenience for prompts and pickers — any code not listed
 * here still works everywhere (see languageDisplayName fallback).
 */
export const COMMON_LANGUAGES: Record<string, string> = {
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  ru: "Русский",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
  hi: "हिन्दी",
  bn: "বাংলা",
  pa: "ਪੰਜਾਬੀ",
  ps: "پښتو",
  nl: "Nederlands",
  sv: "Svenska",
  no: "Norsk",
  da: "Dansk",
  fi: "Suomi",
  pl: "Polski",
  uk: "Українська",
  cs: "Čeština",
  ro: "Română",
  el: "Ελληνικά",
  he: "עברית",
  th: "ไทย",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
  ms: "Bahasa Melayu",
  ta: "தமிழ்",
  te: "తెలుగు",
  mr: "मराठी",
  gu: "ગુજરાતી",
  kn: "ಕನ್ನಡ",
  ml: "മലയാളം",
  ne: "नेपाली",
  si: "සිංහල",
  my: "မြန်မာ",
  km: "ខ្មែរ",
  az: "Azərbaycanca",
  kk: "Қазақша",
  uz: "O'zbekcha",
  ku: "Kurdî",
  sw: "Kiswahili",
  am: "አማርኛ",
};

/** Loose BCP-47-ish shape check for free-text language codes. */
const LANGUAGE_CODE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/** True for any plausible language code ('en', 'es', 'pt-BR', 'ps'). */
export function isValidLanguageCode(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 35 &&
    LANGUAGE_CODE_RE.test(value)
  );
}

/** Normalize a code for lookup: lowercase, primary subtag ('pt-BR' -> 'pt'). */
function primarySubtag(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0];
}

/**
 * Human-readable display name for ANY language code. Prefers the native
 * name from LANGUAGE_NAMES (the five UI languages) then COMMON_LANGUAGES;
 * falls back to the raw code so unknown codes never crash a prompt or UI.
 */
export function languageDisplayName(code: string): string {
  const sub = primarySubtag(code);
  const ui = (LANGUAGE_NAMES as Record<string, string>)[sub];
  if (ui) return ui;
  const common = COMMON_LANGUAGES[sub];
  if (common) return common;
  return code;
}

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  country: string; // ISO-3166-1 alpha-2, uppercase
  totpEnabled: boolean;
  /** Server-side UI/chat language preference; set via PATCH /account/me. */
  preferredLanguage?: string;
  /** Billing plan; 'paid' is a placeholder in v1 (not assignable via API). */
  plan: PlanType;
  /** Owner flag; gates the /admin/* API. */
  isOwner: boolean;
  /**
   * Step 10 (Apple 5.1.2(i)): whether the user has accepted the AI notice
   * (recorded via PATCH /account/me {aiNoticeAccepted: true}).
   */
  aiNoticeAccepted: boolean;
  createdAt: string;
}

export type PublicUser = User;

export interface Device {
  id: string;
  deviceName: string;
  ip: string | null;
  lastActiveAt: string;
  createdAt: string;
  current: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  /** Optional machine-readable extras, e.g. { resetAt } on LIMIT_EXCEEDED. */
  details?: Record<string, unknown>;
}

export type ApiResponse<T> =
  | { data: T; error?: never }
  | { data?: never; error: ApiErrorBody };

export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "kling"
  | "steel"
  | "elevenlabs";

export type Capability = "chat" | "search" | "image" | "video" | "voice" | "browser";

export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  enabled: boolean;
  capabilities: Capability[];
  regions: string[]; // ISO country codes this provider may serve
}

export interface RegionRule {
  country: string;
  providers: ProviderId[];
}

export interface ConsentRecord {
  provider: string;
  grantedAt: string;
  revokedAt: string | null;
}

export interface MeteringEvent {
  id: string;
  feature: string;
  provider: string | null;
  units: number;
  costUsd: number | null;
  createdAt: string;
}

export interface AccountExport {
  user: User;
  devices: Device[];
  consentRecords: ConsentRecord[];
  usageSummary: MeteringEvent[];
  exportedAt: string;
}

/* ---------- Step 2: chat ---------- */

export type TaskType = "chat" | "reasoning" | "long-context";

export type ChatRole = "user" | "assistant";

export interface ChatThread {
  id: string;
  title: string;
  /** Project this thread belongs to (null = no project). */
  projectId: string | null;
  /** Lockdown mode: no web/research tools, no agent actions, no memory writes. */
  lockdown: boolean;
  /** True when older messages were compacted into a summary. */
  compacted: boolean;
  /** Gem this thread chats with (null = no gem). */
  gemId: string | null;
  /** Teach-me (tutor) mode: guided questions/hints instead of direct answers. */
  tutorMode: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One message in a temporary (stateless) chat request — never persisted. */
export interface TempChatMessageInput {
  role: ChatRole;
  content: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  content: string;
  /** Provider that produced this message ("demo" for demo mode). */
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when the reply came from the built-in demo provider (zero keys). */
  demo: boolean;
  createdAt: string;
}

/** SSE wire events for POST /chat/threads/:id/messages (text/event-stream). */
export type ChatStreamEvent =
  | { type: "start"; threadId: string; provider: string; model: string; demo: boolean; messageId: string }
  | { type: "token"; text: string }
  /** Sent (once, right after start) when older messages were auto-summarized during this request. */
  | { type: "compacted" }
  /** Plain-language connector activity during a chat tool loop (Step 6). */
  | { type: "tool_activity"; message: string }
  /** Terminal pause: a connector write tool needs user confirmation (Step 6). */
  | { type: "confirmation_required"; confirmation: ConnectorConfirmation }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; code: string; message: string };

export interface ConsentProviderStatus {
  /** Provider id, e.g. "anthropic". */
  id: string;
  /** Plain-language display name shown in the consent UI. */
  name: string;
  /** Plain-language sentence describing what data is sent. */
  whatSees: string;
  /** True when this provider could actually be used for this user right now. */
  required: boolean;
  /** True when the user has a live (unrevoked) consent record. */
  granted: boolean;
}

/** Every API route path. Import this — never hardcode paths. */
export const API_ROUTES = {
  health: "/api/v1/health",
  providersStatus: "/api/v1/providers/status",
  signup: "/api/v1/auth/signup",
  verifyEmail: "/api/v1/auth/verify-email",
  login: "/api/v1/auth/login",
  login2fa: "/api/v1/auth/login/2fa",
  refresh: "/api/v1/auth/refresh",
  logout: "/api/v1/auth/logout",
  logoutAll: "/api/v1/auth/logout-all",
  forgotPassword: "/api/v1/auth/forgot-password",
  resetPassword: "/api/v1/auth/reset-password",
  devices: "/api/v1/auth/devices",
  twoFaSetup: "/api/v1/auth/2fa/setup",
  twoFaEnable: "/api/v1/auth/2fa/enable",
  twoFaDisable: "/api/v1/auth/2fa/disable",
  oauthGoogle: "/api/v1/auth/oauth/google",
  oauthGoogleCallback: "/api/v1/auth/oauth/google/callback",
  me: "/api/v1/account/me",
  export: "/api/v1/account/export",
  deleteAccount: "/api/v1/account",
  /* Step 2: chat */
  chatThreads: "/api/v1/chat/threads",
  chatThread: (threadId: string) => `/api/v1/chat/threads/${threadId}`,
  chatMessages: (threadId: string) => `/api/v1/chat/threads/${threadId}/messages`,
  chatMessage: (messageId: string) => `/api/v1/chat/messages/${messageId}`,
  chatConsent: "/api/v1/chat/consent",
  chatConsentProvider: (provider: string) => `/api/v1/chat/consent/${provider}`,
  /* Quick wins: temporary (stateless) chat */
  chatTempMessages: "/api/v1/chat/temporary/messages",
  /* Step 3: files, projects, library */
  files: "/api/v1/files",
  file: (fileId: string) => `/api/v1/files/${fileId}`,
  fileLink: (fileId: string) => `/api/v1/files/${fileId}/link`,
  projects: "/api/v1/projects",
  project: (projectId: string) => `/api/v1/projects/${projectId}`,
  library: "/api/v1/library",
  libraryItem: (type: string, id: string) => `/api/v1/library/${type}/${id}`,
  /* Step 4: research, write, memory */
  researchJobs: "/api/v1/research/jobs",
  researchJob: (jobId: string) => `/api/v1/research/jobs/${jobId}`,
  researchJobStart: (jobId: string) => `/api/v1/research/jobs/${jobId}/start`,
  researchJobEvents: (jobId: string) => `/api/v1/research/jobs/${jobId}/events`,
  researchJobExport: (jobId: string) => `/api/v1/research/jobs/${jobId}/export`,
  researchJobCitations: (jobId: string) => `/api/v1/research/jobs/${jobId}/citations`,
  writeDrafts: "/api/v1/write/drafts",
  writeDraft: (draftId: string) => `/api/v1/write/drafts/${draftId}`,
  writeDraftRevise: (draftId: string) => `/api/v1/write/drafts/${draftId}/revise`,
  writeDraftFactCheck: (draftId: string) => `/api/v1/write/drafts/${draftId}/fact-check`,
  writeDraftExport: (draftId: string) => `/api/v1/write/drafts/${draftId}/export`,
  writeFactCheck: (checkId: string) => `/api/v1/write/fact-checks/${checkId}`,
  writeStyles: "/api/v1/write/styles",
  writeStyle: (styleId: string) => `/api/v1/write/styles/${styleId}`,
  memories: "/api/v1/memory",
  memoryItem: (memoryId: string) => `/api/v1/memory/${memoryId}`,
  /* Step 5: usage dashboard + owner admin */
  usageSummary: "/api/v1/usage/summary",
  adminProviders: "/api/v1/admin/providers",
  adminProvider: (providerId: string) => `/api/v1/admin/providers/${providerId}`,
  /* Abuse protection: owner user safety */
  adminUsers: "/api/v1/admin/users",
  adminUserBan: (userId: string) => `/api/v1/admin/users/${userId}/ban`,
  adminUserUnban: (userId: string) => `/api/v1/admin/users/${userId}/unban`,
  adminAbuseEvents: "/api/v1/admin/abuse-events",
  /* Step 6: connectors + skills */
  connectors: "/api/v1/connectors",
  connectorAuthorize: (connectorId: string) => `/api/v1/connectors/${connectorId}/authorize`,
  connectorCallback: (connectorId: string) => `/api/v1/connectors/${connectorId}/callback`,
  connectorDisconnect: (connectorId: string) => `/api/v1/connectors/${connectorId}/disconnect`,
  connectorTools: (connectorId: string) => `/api/v1/connectors/${connectorId}/tools`,
  connectorCallTool: (connectorId: string, tool: string) =>
    `/api/v1/connectors/${connectorId}/tools/${tool}/call`,
  connectorConfirmations: "/api/v1/connectors/confirmations",
  connectorConfirmation: (confirmationId: string) =>
    `/api/v1/connectors/confirmations/${confirmationId}`,
  connectorConfirmationConfirm: (confirmationId: string) =>
    `/api/v1/connectors/confirmations/${confirmationId}/confirm`,
  connectorConfirmationCancel: (confirmationId: string) =>
    `/api/v1/connectors/confirmations/${confirmationId}/cancel`,
  connectorAudit: "/api/v1/connectors/audit",
  /* Gmail send has no MCP tool (drafts only) — direct Gmail API call, confirmation-gated */
  connectorGmailSend: "/api/v1/connectors/gmail/send",
  skills: "/api/v1/skills",
  skill: (skillId: string) => `/api/v1/skills/${skillId}`,
  projectSkills: (projectId: string) => `/api/v1/projects/${projectId}/skills`,
  projectSkill: (projectId: string, skillId: string) =>
    `/api/v1/projects/${projectId}/skills/${skillId}`,
  threadSkills: (threadId: string) => `/api/v1/chat/threads/${threadId}/skills`,
  threadSkill: (threadId: string, skillId: string) =>
    `/api/v1/chat/threads/${threadId}/skills/${skillId}`,
  /* Chat polish: Gems (shareable custom assistants) + Guided Learning */
  gems: "/api/v1/gems",
  gem: (gemId: string) => `/api/v1/gems/${gemId}`,
  gemShare: (gemId: string) => `/api/v1/gems/${gemId}/share`,
  gemSharedClone: (token: string) => `/api/v1/gems/shared/${token}`,
  gemSkills: (gemId: string) => `/api/v1/gems/${gemId}/skills`,
  gemSkill: (gemId: string, skillId: string) => `/api/v1/gems/${gemId}/skills/${skillId}`,
  gemFiles: (gemId: string) => `/api/v1/gems/${gemId}/files`,
  gemFile: (gemId: string, fileId: string) => `/api/v1/gems/${gemId}/files/${fileId}`,
  /* Step 6b: generic MCP extensibility — user-registered servers */
  customConnectors: "/api/v1/connectors/custom",

  customConnector: (id: string) => `/api/v1/connectors/custom/${id}`,
  customConnectorAuthorize: (id: string) => `/api/v1/connectors/custom/${id}/authorize`,
  customConnectorCallback: (id: string) => `/api/v1/connectors/custom/${id}/callback`,
  customConnectorDisconnect: (id: string) => `/api/v1/connectors/custom/${id}/disconnect`,
  /* Step 7: agent (backend core) */
  agentTasks: "/api/v1/agent/tasks",
  agentTask: (taskId: string) => `/api/v1/agent/tasks/${taskId}`,
  agentTaskApprove: (taskId: string) => `/api/v1/agent/tasks/${taskId}/approve`,
  agentTaskCancel: (taskId: string) => `/api/v1/agent/tasks/${taskId}/cancel`,
  agentTaskEvents: (taskId: string) => `/api/v1/agent/tasks/${taskId}/events`,
  agentTaskTakeover: (taskId: string) => `/api/v1/agent/tasks/${taskId}/takeover`,
  agentApprovalDecide: (approvalId: string) => `/api/v1/agent/approvals/${approvalId}/decide`,
  /* Step 7b: agent schedules + notifications (backend-extra). The sibling core
     worker adds the core agent entries above this comment when they land. */
  agentSchedules: "/api/v1/agent/schedules",
  agentSchedule: (id: string) => `/api/v1/agent/schedules/${id}`,
  agentScheduleApproveFirstRun: (id: string) => `/api/v1/agent/schedules/${id}/approve-first-run`,
  agentNotifications: "/api/v1/agent/notifications",
  agentNotificationRead: (id: string) => `/api/v1/agent/notifications/${id}/read`,
  /* Step 8: browser-based connections (sites with no API and no MCP server) */
  browserSites: "/api/v1/connectors/browser-sites",
  browserSite: (siteId: string) => `/api/v1/connectors/browser-sites/${siteId}`,
  browserSiteLogin: (siteId: string) => `/api/v1/connectors/browser-sites/${siteId}/login`,
  browserSiteLoginComplete: (siteId: string) =>
    `/api/v1/connectors/browser-sites/${siteId}/login/complete`,
  browserSiteCheck: (siteId: string) => `/api/v1/connectors/browser-sites/${siteId}/check`,
  /* Step 9: studio (images, voice, video director, audio overviews) */
  studioImages: "/api/v1/studio/images",
  studioImage: (imageId: string) => `/api/v1/studio/images/${imageId}`,
  studioImageEdit: (imageId: string) => `/api/v1/studio/images/${imageId}/edit`,
  studioVoiceTranscribe: "/api/v1/studio/voice/transcribe",
  studioVoiceSpeak: "/api/v1/studio/voice/speak",
  chatThreadVoice: (threadId: string) => `/api/v1/chat/threads/${threadId}/voice`,
  studioVideos: "/api/v1/studio/videos",
  studioVideo: (videoId: string) => `/api/v1/studio/videos/${videoId}`,
  studioVideoApprove: (videoId: string) => `/api/v1/studio/videos/${videoId}/approve`,
  studioVideoEvents: (videoId: string) => `/api/v1/studio/videos/${videoId}/events`,
  studioVideoShot: (videoId: string, shotId: string) =>
    `/api/v1/studio/videos/${videoId}/shots/${shotId}`,
  studioVideoShotRegenerate: (videoId: string, shotId: string) =>
    `/api/v1/studio/videos/${videoId}/shots/${shotId}/regenerate`,
  studioVideoShotReorder: (videoId: string, shotId: string) =>
    `/api/v1/studio/videos/${videoId}/shots/${shotId}/reorder`,
  studioVideoShotPreview: (videoId: string, shotId: string) =>
    `/api/v1/studio/videos/${videoId}/shots/${shotId}/preview`,
  studioAudioOverviews: "/api/v1/studio/audio-overviews",
  studioAudioOverview: (overviewId: string) => `/api/v1/studio/audio-overviews/${overviewId}`,
  studioConsent: "/api/v1/studio/consent",
  /* Step 10: store readiness — Sign in with Apple, moderation */
  authApple: "/api/v1/auth/apple",
  moderationReport: "/api/v1/moderation/report",
  moderationReports: "/api/v1/moderation/reports",
  moderationReportItem: (reportId: string) =>
    `/api/v1/moderation/reports/${reportId}`,
  moderationBlock: "/api/v1/moderation/block",
  moderationUnblock: (userId: string) => `/api/v1/moderation/block/${userId}`,
} as const;

/* ---------- Step 10: store readiness (moderation) ---------- */

export type ModerationContentType =
  | "chat_message"
  | "image"
  | "video"
  | "audio"
  | "gem"
  | "shared_content";

export type ModerationReportStatus = "open" | "triaged" | "resolved" | "dismissed";

/** A content report filed from the mobile/web report buttons. */
export interface ModerationReport {
  id: string;
  reporterId: string;
  contentType: ModerationContentType;
  contentId: string;
  reason: string;
  details: string | null;
  status: ModerationReportStatus;
  createdAt: string;
}

/* ---------- Step 9: studio ---------- */

export type StudioImageStatus = "pending" | "ready" | "failed";

/** A generated picture. `imageUrl` is a signed URL — never raw bytes. */
export interface StudioImage {
  id: string;
  prompt: string;
  aspectRatio: "square" | "wide" | "tall";
  status: StudioImageStatus;
  /** Signed playback URL (present when ready). */
  imageUrl: string | null;
  createdAt: string;
}

export interface StudioSpeakResult {
  /** Signed playback URL of the spoken audio. */
  audioUrl: string;
}

export interface StudioTranscript {
  text: string;
}

export type StudioVideoStatus =
  | "estimating"
  | "awaiting_approval"
  | "running"
  | "done"
  | "failed"
  | "discarded";

export interface StudioVideoEstimate {
  /** USD, rounded to cents. */
  costUsd: number;
  /** Total seconds of finished video. */
  totalSeconds: number;
  /** How long making it will take, in minutes. */
  estimatedMinutes: number;
}

/** The eight making stages, in order. */
export const STUDIO_VIDEO_STAGE_IDS = [
  "idea",
  "script",
  "storyboard",
  "shots",
  "voiceover",
  "music",
  "captions",
  "assembly",
] as const;
export type StudioVideoStageId = (typeof STUDIO_VIDEO_STAGE_IDS)[number];

export interface StudioVideoStage {
  id: StudioVideoStageId;
  status: "waiting" | "running" | "done" | "failed";
  /** 0–100 within this stage. */
  progress: number;
}

export interface StudioShot {
  id: string;
  /** Order in the video (0-based). */
  order: number;
  prompt: string;
  /** On-screen seconds. */
  durationSeconds: number;
  status: "pending" | "ready" | "failed";
  /** Signed playback URL (present when ready). */
  previewUrl: string | null;
}

export interface StudioVideo {
  id: string;
  brief: string;
  targetMinutes: number;
  status: StudioVideoStatus;
  /** Present after estimating — the plan the user approves. */
  estimate: StudioVideoEstimate | null;
  stages: StudioVideoStage[];
  shots: StudioShot[];
  /** Signed playback URL of the finished MP4 (present when done). */
  videoUrl: string | null;
  createdAt: string;
}

export type StudioVideoEvent =
  | { type: "progress"; stage: StudioVideoStageId; done: number; total: number; message?: string }
  | { type: "shot"; shot: StudioShot }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

export type AudioOverviewLength = "short" | "medium" | "long";

export interface AudioOverview {
  id: string;
  title: string;
  length: AudioOverviewLength;
  status: "pending" | "ready" | "failed";
  /** Signed playback URL of the spoken summary (present when ready). */
  audioUrl: string | null;
  createdAt: string;
}

/* ---------- Step 9: studio error codes ---------- */

/** No provider may serve this request (unknown/blocked country, kill switch,
 *  unconfigured, or retired model). HTTP 503. */
export const NO_PROVIDER_AVAILABLE = "NO_PROVIDER_AVAILABLE" as const;
/** The routed provider needs the user's consent first. HTTP 403. */
export const CONSENT_REQUIRED = "CONSENT_REQUIRED" as const;
/** The routed provider call itself failed. HTTP 502. */
export const PROVIDER_ERROR = "PROVIDER_ERROR" as const;

/* ---------- Step 3: files, projects, library ---------- */

export type FileStatus = "ready" | "extracting" | "failed";

export type TranscriptStatus = "ready" | "not_configured" | "failed";

/** File metadata as returned by list endpoints (no extracted text). */
export interface GenzeFile {
  id: string;
  projectId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: FileStatus;
  /** Audio only: null for non-audio files. */
  transcriptStatus: TranscriptStatus | null;
  imageWidth: number | null;
  imageHeight: number | null;
  /** True when extracted_text is present. */
  hasText: boolean;
  createdAt: string;
  /** Only present on GET /files/:id. */
  extractedText?: string | null;
}

export interface Project {
  id: string;
  title: string;
  /** Saved instructions injected as the system prompt for project chats. */
  instructions: string;
  fileCount: number;
  /** Default writing style for this project (Step 4). */
  defaultStyleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LibraryItemType =
  | "project"
  | "chat"
  | "file"
  | "report"
  | "video"
  | "agent-task"
  | "image"
  | "audio";

/* ---------- Step 5: plans, limits, credits, admin ---------- */

/** Features with daily quotas. `files` is metered in whole MB. */
export type MeteredFeature = "chat" | "research" | "agent" | "video" | "files";

export interface FeatureUsage {
  feature: MeteredFeature;
  /** Units consumed since UTC midnight. */
  used: number;
  /** Daily cap for the user's plan; null = unlimited. */
  cap: number | null;
  /** ISO timestamp of the next UTC midnight (when usage resets). */
  resetAt: string;
}

export interface UsageSummary {
  plan: PlanType;
  /** UTC date the figures cover, YYYY-MM-DD. */
  day: string;
  features: FeatureUsage[];
  credits: {
    balance: number;
    /** Credits granted today (free-plan daily grant). */
    grantedToday: number;
  };
  /** Sum of usage_events.cost_usd today. */
  costUsdToday: number;
}

/** Owner-facing provider row (GET /admin/providers). */
export interface ProviderAdminStatus {
  id: ProviderId;
  configured: boolean;
  /** False when kill-switched (env or DB). */
  enabled: boolean;
  /** Where the kill came from; null when not killed. */
  killedBy: "env" | "db" | null;
  regions: string[];
  capabilities: Capability[];
}

/** Owner-facing user row (GET /admin/users). */
export interface AdminUserRow {
  id: string;
  email: string;
  isOwner: boolean;
  bannedAt: string | null;
  banReason: string | null;
  createdAt: string;
}

/** Owner-facing abuse signal row (GET /admin/abuse-events). */
export interface AbuseEventRow {
  id: string;
  userId: string;
  email: string;
  kind: string;
  detail: string | null;
  createdAt: string;
}

/** Error details carried on LIMIT_EXCEEDED (429). */
export interface LimitExceededDetails {
  feature: MeteredFeature;
  resetAt: string;
}

/** Error code for over-quota requests (HTTP 429). */
export const LIMIT_EXCEEDED = "LIMIT_EXCEEDED" as const;

export interface LibraryItem {
  id: string;
  title: string;
  snippet: string | null;
  updatedAt: string;
  /** Signed preview URL (image group: the picture itself). */
  thumbnailUrl?: string | null;
  /** Signed playable/download URL (audio group). */
  playUrl?: string | null;
}

export interface LibraryGroup {
  type: LibraryItemType;
  items: LibraryItem[];
}

/* ---------- Step 4: research, write, memory ---------- */

export type ResearchJobStatus = "planned" | "running" | "done" | "failed" | "cancelled";

export interface ResearchSource {
  n: number;
  url: string;
  title: string;
  fetchedAt: string;
}

/** Live detail for the Claude-style research progress display. */
export interface ResearchProgressDetail {
  /** Search queries the research is running (search phase). */
  queries?: string[];
  /** Sources opened so far, in order (fetch phase). */
  opened?: { title: string; url: string }[];
}

export interface ResearchProgress {
  phase: string;
  done: number;
  total: number;
  message?: string;
  detail?: ResearchProgressDetail;
}

export interface ResearchJob {
  id: string;
  threadId: string | null;
  topic: string;
  status: ResearchJobStatus;
  /** 3–6 steps; present after the background plan step finishes. */
  plan: { steps: string[] } | null;
  progress: ResearchProgress;
  reportMarkdown: string | null;
  sources: ResearchSource[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** SSE events from GET /research/jobs/:id/events. */
export type ResearchEvent =
  | { type: "progress"; phase: string; done: number; total: number; message?: string }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

export type WriteTemplate =
  | "article"
  | "essay"
  | "summary"
  | "youtube-script"
  | "podcast-outline"
  | "email";

export interface WriteDraft {
  id: string;
  projectId: string | null;
  title: string;
  template: WriteTemplate;
  content: string;
  styleId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* Step 4 multilingual v1: revise actions. Translate accepts any language:
   the five quick actions below, or `translate-<code>` for any BCP-47 code
   (user correction 2026-10-18: no language enum restriction). */
export type ReviseAction =
  | "shorter"
  | "simpler"
  | "formal"
  | `translate-${string}`;

/** The five quick translate buttons shown in the Write UI. */
export const QUICK_TRANSLATE_ACTIONS: ReviseAction[] = [
  "translate-en",
  "translate-ur",
  "translate-ar",
  "translate-tr",
  "translate-fa",
];

export interface WritingStyle {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export type FactCheckStatus = "planned" | "running" | "done" | "failed" | "cancelled";

export type ClaimVerdict = "supported" | "disputed" | "unverified";

export interface FactClaimSource {
  n: number;
  url: string;
  title: string;
}

export interface FactClaim {
  claim: string;
  verdict: ClaimVerdict;
  sources: FactClaimSource[];
}

export interface FactCheck {
  id: string;
  draftId: string;
  threadId: string | null;
  status: FactCheckStatus;
  claims: FactClaim[];
  createdAt: string;
  updatedAt: string;
}

export interface UserMemory {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------- Step 6: connectors + skills ---------- */

export type ConnectorId =
  | "google-drive"
  | "gmail"
  | "google-calendar"
  | "notion"
  | "slack"
  | "github"
  | "dropbox"
  | "onedrive";

export type ConnectorAvailability =
  | "available"
  | "beta"
  | "not_available_yet"
  | "coming_later";

export interface ConnectorScope {
  id: string;
  /** Plain-language label, e.g. "Read your files". Never a raw OAuth scope string in the UI. */
  label: string;
}

export interface ConnectorDefinition {
  id: ConnectorId;
  name: string;
  blurb: string;
  availability: ConnectorAvailability;
  /** Plain-language note shown when availability is not "available". */
  availabilityNote: string;
  scopes: ConnectorScope[];
  /** Browser-automation fallback marker for sites with no API/MCP (consumed by Step 8). */
  fallback: "browser" | null;
}

export interface ConnectorStatus extends ConnectorDefinition {
  connected: boolean;
  connectedAt?: string;
}

export type ConnectorAuditAction =
  | "connect"
  | "disconnect"
  | "revoke"
  | "tool_call"
  | "write_confirmed"
  | "write_cancelled"
  | "token_refreshed";

export interface ConnectorAuditEntry {
  id: string;
  connectorId: ConnectorId;
  action: ConnectorAuditAction;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConnectorToolInfo {
  name: string;
  /** Plain-language description. Vendor text is treated as data, never instructions. */
  description: string;
  readOnly: boolean;
}

/** Returned by POST .../tools/:tool/call when the tool needs user confirmation. */
export interface ConnectorConfirmation {
  id: string;
  connectorId: ConnectorId;
  tool: string;
  arguments: Record<string, unknown>;
  /** Plain-language summary of exactly what will happen. */
  summary: string;
  expiresAt: string;
}

export interface ConnectorToolCallResult {
  confirmationRequired?: false;
  result: unknown;
}

export type ConnectorToolCallResponse =
  | { confirmationRequired: true; confirmation: ConnectorConfirmation }
  | ConnectorToolCallResult;

/** SSE event emitted when chat pauses for a connector write confirmation. */
export interface ChatConfirmationRequiredEvent {
  type: "confirmation_required";
  confirmation: ConnectorConfirmation;
}

/** SSE event for plain-language connector activity during a chat tool loop. */
export interface ChatToolActivityEvent {
  type: "tool_activity";
  message: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  scripts: string[];
  /** True for the 3 built-in skills; they are read-only templates users clone. */
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export const CONNECTOR_NOT_AVAILABLE = "CONNECTOR_NOT_AVAILABLE" as const;
export const CONNECTOR_NOT_CONNECTED = "CONNECTOR_NOT_CONNECTED" as const;
export const OAUTH_FAILED = "OAUTH_FAILED" as const;
export const CONFIRMATION_EXPIRED = "CONFIRMATION_EXPIRED" as const;
export const CONNECTOR_ERROR = "CONNECTOR_ERROR" as const;

/* ---------- Step 8: browser-site error codes ---------- */

/** The saved login no longer works — the user must log in again (409). */
export const BROWSER_SESSION_EXPIRED = "BROWSER_SESSION_EXPIRED" as const;
/** The site was added but the user never completed a login (409). */
export const BROWSER_NOT_LOGGED_IN = "BROWSER_NOT_LOGGED_IN" as const;
/** A write was attempted through a read-only browser session (403). */
export const BROWSER_WRITE_NOT_ALLOWED = "BROWSER_WRITE_NOT_ALLOWED" as const;
/** The active browser driver can't save/restore login profiles (502). */
export const BROWSER_PROFILE_UNSUPPORTED = "BROWSER_PROFILE_UNSUPPORTED" as const;
/** Generic browser-driver failure (502). */
export const BROWSER_ERROR = "BROWSER_ERROR" as const;
/** A guided login session expired or is unknown (410). */
export const LOGIN_SESSION_EXPIRED = "LOGIN_SESSION_EXPIRED" as const;
/** A browser site was requested for a task that isn't runnable (409). */
export const TASK_NOT_RUNNING = "TASK_NOT_RUNNING" as const;

/* ---------- Step 8: browser-site types ---------- */

/** never = added but never logged in; active = logged in; expired = log in again. */
export type BrowserSiteStatus = "never" | "active" | "expired";

export interface BrowserSite {
  id: string;
  name: string;
  url: string;
  status: BrowserSiteStatus;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface BrowserLoginSession {
  loginSessionId: string;
  liveViewUrl: string | null;
  expiresAt: string;
}

export type BrowserSessionDetection = "logged_in" | "logged_out" | "unknown";

/* ---------- Step 7: agent error codes ---------- */

export const BROWSER_NOT_CONFIGURED = "BROWSER_NOT_CONFIGURED" as const;
export const CREDITS_EXHAUSTED = "CREDITS_EXHAUSTED" as const;
/** Raised when a task scoped to a project touches another project's files
 *  (folder-scope guard; owned by the sibling worker — defined here so both
 *  sides share the code). */
export const SCOPE_VIOLATION = "SCOPE_VIOLATION" as const;

/* ---------- Step 6b: generic MCP extensibility ---------- */

/** How a user-registered MCP server authenticates. */
export type CustomConnectorAuthType = "oauth" | "token";

export interface CustomConnector {
  id: string;
  name: string;
  mcpUrl: string;
  authType: CustomConnectorAuthType;
  /** Browser automation fallback marker (consumed by Step 8). */
  fallback: "browser" | null;
  connected: boolean;
  connectedAt?: string;
}

/** Connector reference accepted by the tools/call/confirmations/audit endpoints:
 *  a built-in ConnectorId or a custom connector uuid. */
export type ConnectorRef = string;

/* ---------- Step 7: agent (backend core) ---------- */

/** Lifecycle of an agent task. `scheduled` kind rows are created by the
 *  sibling worker's scheduler; the core statuses are identical. */
export type AgentTaskStatus =
  | "planned"
  | "awaiting_approval"
  | "running"
  | "awaiting_confirmation"
  | "paused_takeover"
  | "done"
  | "failed"
  | "cancelled"
  | "limit_stopped";

export type AgentTaskKind = "task" | "scheduled";

export type AgentPlanStepAction = "goto" | "act" | "extract";

export interface AgentPlanStep {
  n: number;
  action: AgentPlanStepAction;
  url?: string;
  description: string;
}

export interface AgentPlan {
  steps: AgentPlanStep[];
  estimatedMinutes: number;
  estimatedCostUsd: number;
  requiresBrowser: boolean;
}

export interface AgentTask {
  id: string;
  kind: AgentTaskKind;
  title: string;
  /** The user's full request text. */
  task: string;
  status: AgentTaskStatus;
  /** Null until the background plan phase finishes. */
  plan: AgentPlan | null;
  projectId: string | null;
  threadId: string | null;
  stepsUsed: number;
  /** Steel live-viewer URL; null for the mock driver. */
  liveViewUrl: string | null;
  reportMarkdown: string | null;
  resultFiles: Array<Record<string, unknown>>;
  screenshots: Array<Record<string, unknown>>;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Risky action kinds that pause a run for explicit approval. */
export type AgentApprovalKind = "payment" | "deletion" | "send" | "public_post" | "form_submit";

export interface AgentApproval {
  id: string;
  taskId: string;
  kind: AgentApprovalKind;
  /** Plain-language summary of exactly what the agent wants to do. */
  summary: string;
  details: Record<string, unknown> | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface AgentNotification {
  id: string;
  taskId: string;
  title: string;
  read: boolean;
  createdAt: string;
}

/** SSE events from GET /agent/tasks/:id/events. */
export type AgentSseEvent =
  | { type: "plan"; plan: AgentPlan | null }
  | {
      type: "status";
      status: AgentTaskStatus;
      stepsUsed: number;
      liveViewUrl: string | null;
    }
  | { type: "approval_required"; approval: AgentApproval }
  | { type: "done"; report: string | null }
  | { type: "error"; code: string; message: string };

/* ---------- Step 7b: agent schedules, folder scope, notifications ---------- */

/** The three recurring schedule shapes a user can create. */
export type AgentScheduleKind = "daily" | "weekly" | "interval_hours";

export type AgentScheduleShape =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "interval_hours"; hours: number };

/** A user-created recurring agent task (see CONTRACTS.md — Step 7). */
export interface AgentSchedule {
  id: string;
  title: string;
  task: string;
  schedule: AgentScheduleShape;
  enabled: boolean;
  /** True when the schedule's runs start immediately without manual approval. */
  autoApprove: boolean;
  /** True after the user approved the first run of a non-auto-approve schedule. */
  approvedOnce: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* AgentNotification is defined once in the Step 7 agent block above (sibling
   core) — identical shape, deduped here. */

/* ---------- Chat polish: Gems (shareable custom assistants) + Guided Learning (tutor mode) ---------- */

/** A Gem: a named custom assistant with its own instructions. */
export interface Gem {
  id: string;
  name: string;
  description: string;
  instructions: string;
  starterPrompts: string[];
  /** Optional model preference (hidden from end users in the UI). */
  modelPreference: string | null;
  /** True for the read-only built-ins (Study Buddy, Email Drafter, Code Reviewer). */
  builtin: boolean;
  /** Name of the original gem this was copied from via a share link (null = not a copy). */
  copiedFrom: string | null;
  /** Share URL — only ever returned to the gem's owner while sharing is active. */
  shareUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

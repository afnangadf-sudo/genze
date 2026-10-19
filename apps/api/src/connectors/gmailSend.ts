// Gmail send (Step 6).
//
// The official Gmail MCP server exposes drafts only — no send tool. Sending
// is therefore a direct Gmail API call
// (POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send,
// RFC 2822 body, base64url) using the stored OAuth token.
//
// Rules, per contract:
// - ONLY through the confirmation card (no confirmationId => a pending
//   confirmation is created and NOTHING is sent).
// - ONLY when the granted scopes include `gmail.send`, else a plain-language
//   error naming the missing permission.

import { getPool } from "../db.js";
import { decryptToken } from "./tokens.js";
import { getDefinition } from "./registry.js";
import {
  ConnectorError,
  auditAction,
  createConfirmation,
  stableStringify,
} from "./manager.js";
import { recordUsage } from "../usage.js";
import type { ConfirmationRequired } from "./types.js";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export interface GmailSendInput {
  to: string;
  subject: string;
  body: string;
  confirmationId?: string;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function rfc2822(to: string, subject: string, body: string): string {
  // Minimal RFC 2822 message; headers are ASCII-safe for the v1 flow.
  const safeSubject = subject.replace(/[\r\n]+/g, " ");
  return `To: ${to}\r\nSubject: ${safeSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
}

export async function sendGmail(
  userId: string,
  input: GmailSendInput,
): Promise<{ sent: true; messageId: string } | ConfirmationRequired> {
  const def = getDefinition("gmail");
  if (!def) throw new ConnectorError(404, "NOT_FOUND", "Unknown connector.");

  const account = await getPool().query<{
    access_token: string;
    scopes: string[];
  }>(
    `SELECT access_token, scopes FROM connector_accounts WHERE user_id = $1 AND connector_id = 'gmail'`,
    [userId],
  );
  const row = account.rows[0];
  if (!row) {
    throw new ConnectorError(400, "CONNECTOR_NOT_CONNECTED", "Connect Gmail first.");
  }
  if (!row.scopes.includes(GMAIL_SEND_SCOPE) && !row.scopes.includes("gmail.send")) {
    throw new ConnectorError(
      403,
      "FORBIDDEN",
      "Gmail sending isn't available — the 'send email' permission wasn't granted when you connected Gmail. Please reconnect and allow it.",
    );
  }

  const args: Record<string, unknown> = { to: input.to, subject: input.subject, body: input.body };

  if (!input.confirmationId) {
    // No confirmation: NOTHING is sent — return the pending card instead.
    const confirmation = await createConfirmation(userId, "gmail", "gmail.send", args);
    return { confirmationRequired: true as const, confirmation };
  }

  // Validate the confirmation matches this exact send (single send, same
  // user/connector/tool/arguments, unexpired).
  const pending = await getPool().query<{
    id: string;
    connector_id: string;
    tool: string;
    arguments: Record<string, unknown>;
    expires_at: Date;
  }>(`SELECT * FROM connector_confirmations WHERE id = $1 AND user_id = $2`, [
    input.confirmationId,
    userId,
  ]);
  const crow = pending.rows[0];
  const expired = crow ? new Date(crow.expires_at).getTime() <= Date.now() : false;
  const matches =
    crow &&
    crow.connector_id === "gmail" &&
    crow.tool === "gmail.send" &&
    stableStringify(crow.arguments) === stableStringify(args);
  if (!crow || expired || !matches) {
    if (crow) await getPool().query("DELETE FROM connector_confirmations WHERE id = $1", [crow.id]);
    throw new ConnectorError(
      410,
      "CONFIRMATION_EXPIRED",
      "This confirmation has expired or doesn't match. Please try again.",
    );
  }

  const raw = base64url(rfc2822(input.to, input.subject, input.body));
  let messageId: string;
  try {
    const res = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decryptToken(row.access_token)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    const body = (await res.json()) as { id?: string; error?: unknown };
    if (!res.ok || !body.id) {
      throw new Error("gmail send failed");
    }
    messageId = body.id;
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(502, "CONNECTOR_ERROR", "We couldn't send that email. Please try again.");
  }

  await getPool().query("DELETE FROM connector_confirmations WHERE id = $1", [crow.id]);
  await auditAction(userId, "gmail", "write_confirmed", { tool: "gmail.send", to: input.to });
  await recordUsage({
    userId,
    feature: "connector_tool",
    provider: "gmail",
    units: 1,
    costUsd: null,
    details: { tool: "gmail.send" },
  });
  return { sent: true as const, messageId };
}

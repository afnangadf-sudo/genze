// Shared helpers for Step 3 API tests: auth flow + multipart uploads.
// Each test file sets its own env before importing buildApp.

import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "@genze/shared";
import { testEmailOutbox } from "../src/email.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const fixture = (name: string): Promise<Buffer> =>
  readFile(join(HERE, "fixtures", name));

export const email = (tag: string) => `s3-${tag}-${randomUUID().slice(0, 8)}@example.com`;

export const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

export function lastTokenFor(to: string): string {
  const found = [...testEmailOutbox].reverse().find((e) => e.to === to);
  expect(found).toBeDefined();
  const m = found!.text.match(/token=([0-9a-f]+)/);
  expect(m).toBeTruthy();
  return m![1];
}

export async function signupVerifyLogin(app: FastifyInstance, em: string): Promise<string> {
  let res = await app.inject({
    method: "POST",
    url: API_ROUTES.signup,
    payload: { email: em, password: "password123", country: "PK" },
  });
  expect(res.statusCode).toBe(201);
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.verifyEmail,
    payload: { token: lastTokenFor(em) },
  });
  expect(res.statusCode).toBe(200);
  res = await app.inject({
    method: "POST",
    url: API_ROUTES.login,
    payload: { email: em, password: "password123" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json().data.tokens as { accessToken: string }).accessToken;
}

export function multipartBody(
  filename: string,
  contentType: string,
  data: Buffer,
  fields: Record<string, string> = {},
): { payload: Buffer; contentType: string } {
  const boundary = `----test${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
  );
  chunks.push(data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function uploadFile(
  app: FastifyInstance,
  token: string,
  filename: string,
  contentType: string,
  data: Buffer,
  fields: Record<string, string> = {},
) {
  const { payload, contentType: ct } = multipartBody(filename, contentType, data, fields);
  return app.inject({
    method: "POST",
    url: API_ROUTES.files,
    headers: { ...authHeader(token), "content-type": ct },
    payload,
  });
}

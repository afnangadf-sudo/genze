// Private object storage behind an S3-compatible interface.
// v1 ships a local-disk driver; S3/MinIO can replace it later with zero code
// change at the call sites (put/get/delete only). Files are NEVER served from
// a public URL — downloads go through short-lived signed links (signed.ts).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  /** Throws StorageNotFound when the key does not exist. */
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;
}

export class StorageNotFound extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageNotFound";
  }
}

function storageDir(): string {
  const env = process.env.STORAGE_DIR;
  if (env && env.length > 0) return env;
  return path.join(process.cwd(), "storage");
}

/** Keys are opaque UUIDs (+ extension); reject anything that could escape the dir. */
function safeKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return key;
}

class LocalStorageDriver implements StorageDriver {
  private dir(): string {
    return storageDir();
  }

  private filePath(key: string): string {
    return path.join(this.dir(), safeKey(key));
  }

  async put(key: string, data: Buffer): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.filePath(key), data);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.filePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StorageNotFound(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.filePath(key), { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

let driver: StorageDriver | null = null;

/** Singleton local-disk driver. Reads STORAGE_DIR lazily per call, so tests
 *  can point it at a temp dir by setting the env var before first use. */
export function getStorage(): StorageDriver {
  if (!driver) driver = new LocalStorageDriver();
  return driver;
}

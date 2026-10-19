// Private object storage behind an S3-compatible interface.
// v1 ships a local-disk driver; S3/MinIO can replace it later with zero code
// change at the call sites (put/get/delete only). Files are NEVER served from
// a public URL — downloads go through short-lived signed links (signed.ts).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
export class StorageNotFound extends Error {
    constructor(key) {
        super(`Storage object not found: ${key}`);
        this.name = "StorageNotFound";
    }
}
function storageDir() {
    const env = process.env.STORAGE_DIR;
    if (env && env.length > 0)
        return env;
    return path.join(process.cwd(), "storage");
}
/** Keys are opaque UUIDs (+ extension); reject anything that could escape the dir. */
function safeKey(key) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key)) {
        throw new Error(`Invalid storage key: ${key}`);
    }
    return key;
}
class LocalStorageDriver {
    dir() {
        return storageDir();
    }
    filePath(key) {
        return path.join(this.dir(), safeKey(key));
    }
    async put(key, data) {
        await mkdir(this.dir(), { recursive: true });
        await writeFile(this.filePath(key), data);
    }
    async get(key) {
        try {
            return await readFile(this.filePath(key));
        }
        catch (err) {
            if (err.code === "ENOENT")
                throw new StorageNotFound(key);
            throw err;
        }
    }
    async delete(key) {
        try {
            await rm(this.filePath(key), { force: true });
        }
        catch (err) {
            if (err.code === "ENOENT")
                return;
            throw err;
        }
    }
}
let driver = null;
/** Singleton local-disk driver. Reads STORAGE_DIR lazily per call, so tests
 *  can point it at a temp dir by setting the env var before first use. */
export function getStorage() {
    if (!driver)
        driver = new LocalStorageDriver();
    return driver;
}
//# sourceMappingURL=index.js.map
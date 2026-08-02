import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { FileStore } from "./types";

// Local disk store for development. Bytes are read back at process time
// (the Reducto processor uploads them for extraction) and by the document
// download route, so keys must stay resolvable for the life of the document
// row. The seed writes its placeholder PDFs here too.
const DEFAULT_UPLOAD_DIR = path.join(process.cwd(), ".files");

export class LocalFileStore implements FileStore {
  constructor(private readonly uploadDir: string = DEFAULT_UPLOAD_DIR) {}

  async put(fileName: string, data: Buffer): Promise<{ storageKey: string }> {
    await mkdir(this.uploadDir, { recursive: true });
    const safeName = fileName.replace(/[^\w.\-]+/g, "_");
    const storageKey = `${randomUUID()}-${safeName}`;
    await writeFile(path.join(this.uploadDir, storageKey), data);
    return { storageKey };
  }

  async get(storageKey: string): Promise<Buffer> {
    const filePath = path.resolve(this.uploadDir, storageKey);
    if (!filePath.startsWith(path.resolve(this.uploadDir) + path.sep)) {
      throw new Error(`Invalid storage key: ${storageKey}`);
    }
    try {
      return await readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Stored file ${storageKey} not found — it may have been cleaned from the upload directory.`,
        );
      }
      throw err;
    }
  }
}

import { randomUUID } from "node:crypto";

import { head, put } from "@vercel/blob";

import type { FileStore } from "./types";

// Vercel Blob store for production. storageKey is the blob *pathname*
// (documents/{uuid}-{name}), not the URL — the storage_key column stays an
// opaque store-relative key with the same semantics as LocalFileStore's
// {uuid}-{name}, and packet children keep sharing the parent's key. The SDK
// reads BLOB_READ_WRITE_TOKEN from the environment.
//
// Access is "public" — the only mode Vercel Blob supports. URLs are
// unguessable capability URLs; the download route enforces org-scoped auth
// before revealing one.
export class BlobFileStore implements FileStore {
  async put(fileName: string, data: Buffer): Promise<{ storageKey: string }> {
    const safeName = fileName.replace(/[^\w.\-]+/g, "_");
    const storageKey = `documents/${randomUUID()}-${safeName}`;
    await put(storageKey, data, {
      access: "public",
      // Our uuid already guarantees uniqueness; a Vercel-added suffix would
      // make the stored key differ from the one we computed.
      addRandomSuffix: false,
    });
    return { storageKey };
  }

  async get(storageKey: string): Promise<Buffer> {
    const url = await this.resolveUrl(storageKey);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Blob fetch failed (${res.status}) for ${storageKey}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Resolve the public URL for a key — used by the download-route redirect. */
  async resolveUrl(storageKey: string): Promise<string> {
    try {
      return (await head(storageKey)).url;
    } catch {
      throw new Error(`Stored file ${storageKey} not found in the blob store.`);
    }
  }
}

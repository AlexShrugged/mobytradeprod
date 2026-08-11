import { randomUUID } from "node:crypto";

import { get, put } from "@vercel/blob";

import type { FileStore } from "./types";

// Vercel Blob store for production. storageKey is the blob *pathname*
// (documents/{uuid}-{name}), not the URL — the storage_key column stays an
// opaque store-relative key with the same semantics as LocalFileStore's
// {uuid}-{name}, and packet children keep sharing the parent's key. The SDK
// authenticates via BLOB_READ_WRITE_TOKEN or Vercel OIDC.
//
// Access is "private" — broker documents must never be world-readable.
// Private blobs have no unauthenticated URL, so there is nothing to
// redirect a browser to: reads go through the SDK and the download route
// streams bytes to the client.
export class BlobFileStore implements FileStore {
  async put(fileName: string, data: Buffer): Promise<{ storageKey: string }> {
    const safeName = fileName.replace(/[^\w.\-]+/g, "_");
    const storageKey = `documents/${randomUUID()}-${safeName}`;
    await put(storageKey, data, {
      access: "private",
      // Our uuid already guarantees uniqueness; a Vercel-added suffix would
      // make the stored key differ from the one we computed.
      addRandomSuffix: false,
    });
    return { storageKey };
  }

  /** Authenticated content stream — the download route pipes this to the
   *  browser so large packets never buffer in the function. */
  async getStream(storageKey: string): Promise<ReadableStream<Uint8Array>> {
    const res = await get(storageKey, { access: "private" });
    if (!res || res.statusCode !== 200 || !res.stream) {
      throw new Error(`Stored file ${storageKey} not found in the blob store.`);
    }
    return res.stream;
  }

  async get(storageKey: string): Promise<Buffer> {
    const stream = await this.getStream(storageKey);
    return Buffer.from(await new Response(stream).arrayBuffer());
  }
}

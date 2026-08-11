import { isProdRuntime } from "@/lib/env";

import { BlobFileStore } from "./blob";
import { LocalFileStore } from "./local";
import type { FileStore } from "./types";

// STORAGE_DRIVER selects the store explicitly; without it, a present
// BLOB_READ_WRITE_TOKEN implies blob. The interface and the storage_key
// column are identical across drivers. On Vercel, falling back to local
// disk is refused — the filesystem there is read-only and per-invocation.
export function getFileStore(): FileStore {
  const driver =
    process.env.STORAGE_DRIVER ??
    (process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "local");
  if (driver === "blob") return new BlobFileStore();
  if (isProdRuntime()) {
    throw new Error(
      "No blob storage configured on Vercel (BLOB_READ_WRITE_TOKEN missing) — refusing the local disk store.",
    );
  }
  return new LocalFileStore();
}

import { LocalFileStore } from "./local";
import type { FileStore } from "./types";

// STORAGE_DRIVER=blob will select a Vercel Blob implementation when we
// deploy; the interface and the storage_key column stay the same.
export function getFileStore(): FileStore {
  return new LocalFileStore();
}

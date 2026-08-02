export interface FileStore {
  /** Persist a file and return the key stored on the document row. */
  put(fileName: string, data: Buffer): Promise<{ storageKey: string }>;
  /** Read back a stored file's bytes by the key on the document row. */
  get(storageKey: string): Promise<Buffer>;
}

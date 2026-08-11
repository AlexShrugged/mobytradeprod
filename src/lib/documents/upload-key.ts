// Client-safe helpers shared by the dropzone (which builds the key it
// uploads to) and the upload-token/register routes (which validate the same
// shape). Must stay dependency-free — it is imported from a client bundle.

export function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^\w.\-]+/g, "_");
}

/** The blob pathname a client-direct upload writes to; recorded verbatim as
 *  the document row's storageKey. Same shape BlobFileStore.put produces. */
export function buildUploadKey(fileName: string): string {
  return `documents/${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
}

export const UPLOAD_KEY_RE =
  /^documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[\w.\-]+$/;

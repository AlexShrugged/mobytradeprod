"use client";

import * as React from "react";

// Shared between the dropzone (publisher) and the documents table
// (renderer): in-flight uploads appear as pending rows at the top of the
// table — where the real rows will land — instead of as a separate list.

export type PendingUpload = {
  /** Stable local key for React lists. */
  key: string;
  name: string;
  size: number;
  pct: number;
  stage: "uploading" | "queued" | "failed";
  /** Set once the blob landed and the row was registered; the table hides
   *  the pending row as soon as a real document with this storageKey
   *  arrives from the server. */
  storageKey?: string;
};

type UploadStatusContext = {
  pending: PendingUpload[];
  setPending: React.Dispatch<React.SetStateAction<PendingUpload[]>>;
};

const Ctx = React.createContext<UploadStatusContext | null>(null);

export function UploadStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [pending, setPending] = React.useState<PendingUpload[]>([]);
  const value = React.useMemo(() => ({ pending, setPending }), [pending]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside a provider — the compact dropzone lives in dialogs with no
 *  documents table, and simply doesn't publish there. */
export function useUploadStatus(): UploadStatusContext | null {
  return React.useContext(Ctx);
}

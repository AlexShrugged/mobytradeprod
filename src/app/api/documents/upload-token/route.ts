import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { UPLOAD_KEY_RE } from "@/lib/documents/upload-key";
import { getCurrentOrgId } from "@/lib/org";

// Issues short-lived client tokens for browser-direct uploads to Vercel
// Blob (entry-packet PDFs exceed the serverless request-body cap, so bytes
// never pass through a function). Row creation happens in the register
// route, driven by the client — onUploadCompleted is deliberately omitted:
// it never fires on localhost and is best-effort in prod (reserved for
// future orphan reconciliation).
export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Auth seam: throws when there is no authenticated organization.
        await getCurrentOrgId();
        if (!UPLOAD_KEY_RE.test(pathname)) {
          throw new Error("Upload pathname must be documents/{uuid}-{name}.");
        }
        return {
          allowedContentTypes: [
            "application/pdf",
            "image/png",
            "image/jpeg",
            "image/tiff",
            "text/csv",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ],
          maximumSizeInBytes: 100 * 1024 * 1024, // entry packets run tens of MB
          addRandomSuffix: false,
        };
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload token refused." },
      { status: 400 },
    );
  }
}

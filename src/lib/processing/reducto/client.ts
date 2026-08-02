import Reducto from "reductoai";

let client: Reducto | null = null;

export function getReductoClient(): Reducto {
  if (!client) {
    client = new Reducto({
      apiKey: process.env.REDUCTO_API_KEY,
      // The SDK default is a full hour; a document that takes longer than
      // three minutes per call should fail loudly, not hold the request open.
      timeout: 180_000,
    });
  }
  return client;
}

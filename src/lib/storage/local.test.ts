import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "./local";

let dir: string;
let store: LocalFileStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "moby-store-"));
  store = new LocalFileStore(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalFileStore", () => {
  it("round-trips bytes through put and get", async () => {
    const data = Buffer.from("fake pdf bytes");
    const { storageKey } = await store.put("entry summary (1).pdf", data);
    expect(storageKey).toMatch(/entry_summary_1_\.pdf$/);
    expect(await store.get(storageKey)).toEqual(data);
  });

  it("rejects keys that escape the upload directory", async () => {
    await expect(store.get("../outside.txt")).rejects.toThrow(
      /Invalid storage key/,
    );
    await expect(store.get("/etc/passwd")).rejects.toThrow(
      /Invalid storage key/,
    );
  });

  it("reports missing files with a readable message", async () => {
    await expect(store.get("nonexistent-key.pdf")).rejects.toThrow(
      /not found/,
    );
  });
});

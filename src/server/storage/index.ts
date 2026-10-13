import type { AttachmentStorageProvider } from "@/generated/prisma/client";
import { localStorage } from "@/server/storage/local";
import { legacyR2 } from "@/server/storage/legacy-r2";

// One place that decides WHICH backend a stored object lives in, so no caller ever guesses from the shape of a key.
//
//   LOCAL  the VPS disk (src/server/storage/local.ts). Every new upload.
//   R2     the legacy Cloudflare R2 bucket (src/server/storage/legacy-r2.ts). Only files uploaded before the move to local storage.
//
// The provider always comes from the Attachment row's own `storageProvider` column. An R2 key is NEVER handed to the local module (and so
// can never be interpreted as a path), and a local key is never sent to R2; the local module additionally refuses any key that is not
// exactly the shape it generates.

export type StoredObjectRef = { provider: AttachmentStorageProvider; key: string };

/** Idempotent delete from the backend that holds it. Throws when the backend cannot confirm the object is gone (so the caller keeps its row). */
export async function removeStoredObject(ref: StoredObjectRef): Promise<void> {
  switch (ref.provider) {
    case "LOCAL":
      return localStorage.remove(ref.key);
    case "R2":
      return legacyR2.remove(ref.key);
    default: {
      // An unknown provider must never be treated as "nothing to delete".
      const unreachable: never = ref.provider;
      throw new Error(`Unknown storage provider: ${String(unreachable)}`);
    }
  }
}

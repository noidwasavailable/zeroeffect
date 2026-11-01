import { Database } from "bun:sqlite";
import { Effect } from "effect";
import type { GmailClientService } from "../../src/server/services/GmailClient";
import { AccountDbTest } from "../../src/server/services/AccountDb";
import { RegistryDbTest } from "../../src/server/services/RegistryDb";

/** Fresh, physically separate SQLite databases for every test case. */
export const makeTestLayers = () => {
  const personalDatabase = new Database(":memory:");
  const workDatabase = new Database(":memory:");
  const registryDatabase = new Database(":memory:");

  return {
    personal: AccountDbTest("personal", personalDatabase),
    work: AccountDbTest("work", workDatabase),
    registry: RegistryDbTest(registryDatabase),
    close: () => {
      personalDatabase.close();
      workDatabase.close();
      registryDatabase.close();
    },
  };
};

/** Gmail client methods most mock clients never call (bulk, attachments, uploads, label edits). */
export const unusedGmailExtras: Pick<GmailClientService, "batchModify" | "getAttachment" | "sendMime" | "renameLabel" | "deleteLabel"> = {
  batchModify: () => Effect.die("unused in this test"),
  getAttachment: () => Effect.die("unused in this test"),
  sendMime: () => Effect.die("unused in this test"),
  renameLabel: () => Effect.die("unused in this test"),
  deleteLabel: () => Effect.die("unused in this test"),
};

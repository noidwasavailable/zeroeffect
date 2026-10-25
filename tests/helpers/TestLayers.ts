import { Database } from "bun:sqlite";
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

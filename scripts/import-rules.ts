// Imports an Inbox Zero rules export into one account's rules file (data/accounts/<account>.rules.json).
//   bun run scripts/import-rules.ts <personal|work> <export.json> [--endpoint <llm-endpoint-id>] [--replace]
// Run it once per account; each account keeps its own copy to edit independently.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { isAccountId } from "../src/shared/api";
import { AccountDb, AccountDbLive } from "../src/server/services/AccountDb";
import { formatRulesFile, importInboxZeroRules } from "../src/server/services/AiRules";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { endpoint: { type: "string" }, replace: { type: "boolean", default: false } },
});
const [accountId, exportPath] = positionals;
if (!isAccountId(accountId) || !exportPath) {
  console.error("Usage: bun run scripts/import-rules.ts <personal|work> <export.json> [--endpoint <llm-endpoint-id>] [--replace]");
  process.exit(1);
}

const dataDirectory = process.env.ACCOUNT_DATA_DIRECTORY ?? "./data/accounts";
const target = join(dataDirectory, `${accountId}.rules.json`);
if (existsSync(target) && !values.replace) {
  console.error(`${target} already exists. Pass --replace to overwrite it.`);
  process.exit(1);
}

const result = importInboxZeroRules(await Bun.file(exportPath).json(), values.endpoint ?? null);
await Effect.runPromise(Effect.gen(function* () {
  const db = yield* AccountDb;
  yield* db.writeRulesFile(formatRulesFile(result.file));
}).pipe(Effect.provide(AccountDbLive(accountId, dataDirectory))));

console.log(`Wrote ${result.imported.length} rule(s) to ${target}: ${result.imported.join(", ")}`);
for (const problem of result.skipped) console.warn(`Skipped ${problem.rule}: ${problem.message}`);
if (!result.file.llmEndpointId) console.warn('No LLM endpoint set. Add one with scripts/llm-endpoint.ts, then set "llmEndpointId" in the file.');

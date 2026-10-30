// Registers (or updates) an OpenAI-compatible LLM endpoint in the registry. The API key is read from
// LLM_API_KEY and stored encrypted with OAUTH_ENCRYPTION_KEY, like the Gmail tokens.
//   LLM_API_KEY=sk-... bun run scripts/llm-endpoint.ts --id openai --base-url https://api.openai.com/v1 \
//     --model gpt-5-mini --api-mode responses [--name "OpenAI"] [--timeout-ms 30000]
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { devServerConfigFromEnvironment } from "../src/server/dev-server";
import { OAuthTokenVault } from "../src/server/services/OAuthTokenVault";
import { RegistryDb, RegistryDbLive } from "../src/server/services/RegistryDb";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    id: { type: "string" },
    name: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    "api-mode": { type: "string" },
    "timeout-ms": { type: "string" },
  },
});
const apiMode = values["api-mode"];
const apiKey = process.env.LLM_API_KEY;
if (!values.id || !values["base-url"] || !values.model || (apiMode !== "responses" && apiMode !== "chat_completions") || !apiKey) {
  console.error("Usage: LLM_API_KEY=... bun run scripts/llm-endpoint.ts --id <id> --base-url <url> --model <model> --api-mode <responses|chat_completions>");
  process.exit(1);
}

const { encryptionKey } = devServerConfigFromEnvironment();
const vault = OAuthTokenVault.fromKey(encryptionKey);
await Effect.runPromise(Effect.gen(function* () {
  const registry = yield* RegistryDb;
  yield* registry.upsertLlmEndpoint({
    id: values.id!,
    name: values.name ?? values.id!,
    baseUrl: values["base-url"]!,
    apiKeyEnc: vault.encrypt(apiKey),
    modelId: values.model!,
    apiMode,
    timeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : 30_000,
  });
}).pipe(Effect.provide(RegistryDbLive(process.env.REGISTRY_DB_PATH ?? "./data/registry.sqlite"))));
console.log(`Saved LLM endpoint '${values.id}' (${values.model}, ${apiMode}). Reference it as "llmEndpointId" in an account's rules file.`);

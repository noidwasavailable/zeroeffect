# AGENTS.md — Engineering Laws, Reference Lookup & Checkpoint Protocol

You are working on **ZeroEffect**, a self-hosted AI email server and keyboard-first web client built with **Bun**, **Effect-TS**, **SQLite (`bun:sqlite`)**, **Redis (`Bun.RedisClient`)**, and **React 19**.

Read this document completely before writing or modifying any code. See `./PRD.md` for product requirements, database schemas, and feature specifications.

---

## 1. Local Reference Repositories (`./repos/`) — Look Before You Write

This workspace contains local clones of upstream repositories inside `./repos/` (which is git-ignored and excluded from `tsconfig.json`). **Do not guess APIs or reinvent complex parsers when the reference code is right on disk.**

```text
./repos/
├── effect/        # git clone [https://github.com/Effect-TS/effect.git](https://github.com/Effect-TS/effect.git)
└── inbox-zero/    # git clone [https://github.com/elie222/inbox-zero.git](https://github.com/elie222/inbox-zero.git)
```

### 1.1 When to Consult `./repos/effect`

Before implementing Effect services, schemas, streams, or layers, search `./repos/effect`:

- **Core Effect, Layers, Context & Fibers:** `./repos/effect/packages/effect/src/`
  - Look up `Effect.gen`, `Context.Service`, `Layer.effect`, `Effect.acquireRelease`, `Schedule.exponential`, `Stream.async`, and `Data.TaggedError`.
- **Schema & Recursive ASTs (Effect v4):** `./repos/effect/packages/effect/src/Schema.ts`
  - Import schemas from `effect/Schema`. Look up `Schema.suspend` (required for the recursive `FilterExpr` Boolean AST), `Schema.TaggedStruct`, `Schema.decodeUnknown`, and JSON Schema generation for LLM structured outputs.
- **Bun Platform Integration:** `./repos/effect/packages/platform-bun/src/`

### 1.2 When to Consult `./repos/inbox-zero`

Before writing Gmail API synchronization, MIME parsing, or LLM prompt construction, search `./repos/inbox-zero`:

- **Gmail Sync, History Deltas & Alias Handling:** `./repos/inbox-zero/apps/web/utils/gmail/`
  - Inspect how Inbox Zero handles `users.history.list` pagination, expired `historyId` (HTTP `404` fallback recovery), thread grouping, MIME multipart traversal (`text/plain` vs `text/html`), HTML sanitization, and RFC 2822 raw message encoding.
- **AI Rule Prompts & Heuristics:** `./repos/inbox-zero/apps/web/utils/llms/` and `./repos/inbox-zero/apps/web/utils/ai/`
  - Inspect system prompt templates, few-shot formatting, and rule matching schemas, then port them cleanly into Effect services.

---

## 2. Non-Negotiable Architecture & Coding Standards

### 2.1 Effect-TS Discipline

1. **Everything Side-Effectful is an `Effect`:**
   - All database queries, Gmail HTTP requests, Redis operations, and LLM calls must return `Effect.Effect<A, E, R>`.
   - Never use bare `async/await` or untyped `try/catch` inside `src/server/services/`. Use `Effect.try` or `Effect.tryPromise` at the boundary with a specific `Data.TaggedError`.
2. **Dependency Injection via `Context.Service` and `Layer`:**
   - Every service (`RegistryDb`, `AccountDb`, `RedisQueue`, `BooleanFilter`, `GmailClient`, `PubSubStream`, `LlmProvider`, `AiRuleWorker`) must define a `Context.Service` and expose both a `Live` layer and a `Test` layer.
3. **Exhaustive Domain Errors (`src/shared/errors.ts`):**
   - Define tagged error classes using `Data.TaggedError`:
     - `AccountIsolationError`
     - `FilterParseError`
     - `GmailApiError` (with `status`, `retryable: boolean`)
     - `LlmEndpointError` (with `apiMode: "responses" | "chat_completions"`, `rawBody`)
     - `DatabaseError`

### 2.2 Strict Multi-Account Silo Enforcement

- **Physical Isolation:** Personal and Work accounts live in separate SQLite database files (`./data/accounts/<account_id>.sqlite`).
- **Scoped Provisioning:** Routes and background workers must resolve the target `accountId` first and provide the scoped `AccountDb` handle via `Effect.provideService(AccountDb, accountDbInstance)`.
- **Forbidden Pattern:** Never store threads, messages, labels, aliases, or AI rules from multiple Gmail accounts in a shared SQLite table.

### 2.3 Bun-Native Primitives Only

- **SQLite:** Always use `import { Database } from "bun:sqlite"`. Do not install `better-sqlite3`, `prisma`, or `drizzle-orm` unless explicitly asked. Enable `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` on every connection.
- **Redis:** Always use `Bun.RedisClient` from `"bun"`.
- **HTTP & WebSockets/SSE:** Always use `Bun.serve()`.
- **Testing:** Always use `import { describe, test, expect, beforeAll, afterAll } from "bun:test"`. Do not install Jest or Vitest.

### 2.4 Dual LLM API Requirement (`/v1/responses` AND `/v1/chat/completions`)

- `LlmProviderService` must support switching between `apiMode: "responses"` and `apiMode: "chat_completions"` per endpoint (overridable per account in its rules file).
- AI rules are evaluated with **one structured call per thread** over the whole rule list (not one call per rule). Both modes must enforce structured JSON output matching the Effect Schema definition for `RuleSelection` (`reasoning`, `matchedRules[{ ruleName, isPrimary }]`, `noMatchFound`, `conversationStatus`), with rule names and statuses constrained by enums in the request schema.
- Rules live per account in `data/accounts/<account_id>.rules.json` (Inbox Zero export shape; see `src/shared/aiRules.ts`). `runOnThreads: false` rules must never cost an LLM call on follow-up messages.

### 2.5 Hybrid UI Requirement (`Cmd+K` + Clickable Buttons + Vim Keys)

- Every user action must be executable in **three ways**:
  1. Via the **`Cmd+K` Command Palette** (`src/client/components/CommandPalette.tsx`).
  2. Via an explicit, clickable **Button** in the UI (`src/client/components/ActionToolbar.tsx`) that displays its keyboard shortcut badge (e.g., `[ Archive [E] ]`).
  3. Via a single-key **Vim shortcut** (`src/client/hooks/useVimShortcuts.ts`) when focus is not inside an `<input>`, `<textarea>`, or `[contenteditable]`.
- Declare every action once in `src/client/actions.ts` (`buildActions`); the palette, buttons and keys all read that registry. Buttons may live in the toolbar, the view sidebar, or a contextual bar (selection bar, reader header). Rare or destructive actions may skip the key (palette + button only); `tests/phase4-api-and-e2e.test.ts` lists those exceptions, and every key must stay unique.
- Thread actions apply to the checked threads when any are checked (bulk, `POST /threads/bulk`), otherwise to the selected thread.
- Text inputs spread `noAutofill` (`src/client/noAutofill.ts`) so password managers do not hijack them.

---

## 3. Durable Testing Requirements (`bun:test`)

Every feature must be accompanied by fast, deterministic, offline-capable tests in `./tests/` using `bun test`.

1. **Zero Real Network Calls in Unit/Integration Tests:**
   - Never call `googleapis.com` or `api.openai.com` in `bun test`.
   - For LLM and Gmail HTTP tests, spin up an ephemeral local mock server inside the test using `Bun.serve({ port: 0, fetch(req) { ... } })` and pass its `server.url` into the Effect test layer.
2. **In-Memory SQLite per Test Case:**
   - In `tests/helpers/TestLayers.ts`, instantiate `new Database(":memory:")` for `personal` and `work` silos so tests run in parallel in milliseconds with zero disk cleanup required.
3. **Boolean AST Equivalence Law:**
   - Any modification to `BooleanFilter.ts` must run the AST equivalence test matrix proving that for every test expression $E$ and every synthetic thread $T$:
     $$\text{evaluateInMemory}(E, T) \equiv \text{querySqliteWithCompiledAst}(E, T)$$
   - The same applies to changes in the shared DSL parser and formatter (`src/shared/filterParser.ts`, `src/shared/filterDsl.ts`). New `FilterExpr` nodes (e.g. Phase 6's full-text `Text` node) must be added to the matrix with one matching rule defined for both targets (see PRD FR-FILTER-04).

---

## 4. Mandatory Phase Execution & Hard Checkpoint Protocol

> **STOP RULE:** The project is structured into **6 sequential phases** (defined in `./PRD.md` Section 5; Phases 1–5 are complete, Phase 6 is next). You must **NEVER** proceed from Phase $N$ to Phase $N+1$ in a single turn or without explicit human approval.

At the end of each phase, you must:

1. Run `bun test` and ensure **0 failures**.
2. Run `bun run typecheck` (`bun check`) and ensure **0 type errors**.
3. Present a concise summary of completed files and print the exact **Hard Checkpoint Verification Commands** for the user to run manually.
4. **STOP and wait** for the user to reply `"Approved, proceed to Phase N+1"` (or provide feedback).

### Quick Summary of the 6 Hard Checkpoints

- **🛑 Checkpoint 1 (After Phase 1):** `AccountDb` physical isolation + `BooleanFilter` recursive `AND`/`OR`/`NOT` DSL parser, SQLite compiler, and in-memory evaluator + `tests/phase1-db-and-filter.test.ts`.
- **🛑 Checkpoint 2 (After Phase 2):** Gmail OAuth2, `history.list` delta sync, MIME parser, `sendAs` alias sync, RFC 2822 alias composer, and outbound GCP Pub/Sub `StreamingPull` listener + `tests/phase2-gmail-sync.test.ts`.
- **🛑 Checkpoint 3 (After Phase 3):** Dual `/v1/responses` & `/v1/chat/completions` `LlmProvider`, `AiRuleWorker` with `FilterExpr` pre-conditions, Ghost Labels (`dry_run`), `ai_audit_logs`, and Undo + `tests/phase3-llm-labeller.test.ts`.
- **🛑 Checkpoint 4 (After Phase 4):** React 19 Web UI (`Cmd+K` palette, Action Toolbar buttons with Vim badges, Account Switcher, Visual/DSL Filter Builder, Shadow-DOM reader, Alias Reply Composer) + `tests/phase4-api-and-e2e.test.ts`. Tailscale exposure and authentication are managed outside this app (no auth middleware).
- **🛑 Checkpoint 5 (After Phase 5):** Catch-up `history.list` sync, attachments in and out (download route, inline `cid:` images, upload-endpoint sending), Forward, Trash & Spam, bulk actions + "Mark all as read", label management, Send As aliases page, and the extra palette commands/keys + `tests/phase5-mail-features.test.ts`.
- **🛑 Checkpoint 6 (After Phase 6):** Full-text search: `Text` `FilterExpr` node in the shared parser/formatter/builder, `messages_fts MATCH` compilation with bound prefix queries, identical in-memory tokenizer, and the extended AST equivalence matrix + `tests/phase6-search.test.ts`.

---

## 5. Repository Layout Reference

```text
zero-effect/
├── PRD.md                          # Product requirements, schemas & roadmap
├── AGENTS.md                       # This file: Agent laws, ./repos lookup & checkpoints
├── repos/                          # Git-ignored reference clones (effect, inbox-zero)
├── data/                           # Git-ignored SQLite databases (registry + accounts/)
├── scripts/
│   ├── setup-repos.sh              # Clones effect and inbox-zero into ./repos/
│   └── cli-filter-demo.ts          # CLI inspector for Checkpoint 1
├── src/
│   ├── server/
│   │   ├── main.ts                 # Bun.serve() entry, background workers, catch-up sync timer
│   │   ├── dev-server.ts           # HTTP server: setup/OAuth pages, client bundle, sync jobs
│   │   ├── services/
│   │   │   ├── RegistryDb.ts
│   │   │   ├── AccountDb.ts
│   │   │   ├── RedisQueue.ts
│   │   │   ├── BooleanFilter.ts
│   │   │   ├── GmailClient.ts
│   │   │   ├── GmailSyncService.ts
│   │   │   ├── GmailAccountOperations.ts # Per-account sync, watches, catch-up
│   │   │   ├── MimeParser.ts       # Bodies + attachment metadata
│   │   │   ├── SendAsComposerService.ts # RFC 2822 replies, forwards, attachments
│   │   │   ├── PubSubListenerService.ts
│   │   │   ├── LlmProvider.ts
│   │   │   └── AiRuleWorker.ts
│   │   └── routes/
│   │       ├── api.ts
│   │       └── sse.ts
│   ├── client/
│   │   ├── App.tsx
│   │   ├── actions.ts              # The single action registry (palette, buttons, keys)
│   │   ├── noAutofill.ts
│   │   ├── components/
│   │   │   ├── CommandPalette.tsx
│   │   │   ├── ActionToolbar.tsx
│   │   │   ├── AccountSwitcher.tsx
│   │   │   ├── FilterBuilder.tsx
│   │   │   ├── ThreadList.tsx
│   │   │   ├── ThreadReader.tsx
│   │   │   ├── ReplyComposer.tsx
│   │   │   ├── NewMessageDialog.tsx # New messages and forwards
│   │   │   ├── AttachmentField.tsx
│   │   │   ├── ShortcutHelp.tsx
│   │   │   └── AiAuditDrawer.tsx
│   │   └── hooks/
│   │       └── useVimShortcuts.ts
│   └── shared/
│       ├── api.ts                  # Wire types shared by server and client
│       ├── filterParser.ts         # DSL parser shared by server and browser
│       ├── schemas.ts              # Effect Schema definitions
│       └── errors.ts               # Data.TaggedError definitions
├── tests/
│   ├── helpers/
│   │   └── TestLayers.ts
│   ├── phase1-db-and-filter.test.ts
│   ├── phase2-gmail-sync.test.ts
│   ├── phase3-llm-labeller.test.ts
│   ├── phase4-api-and-e2e.test.ts
│   ├── phase5-mail-features.test.ts
│   └── phase6-search.test.ts       # (Phase 6)
├── package.json
└── tsconfig.json
```

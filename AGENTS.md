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
  - Look up `Effect.gen`, `Context.Tag`, `Layer.effect`, `Layer.scoped`, `Schedule.exponential`, `Stream.async`, and `Data.TaggedError`.
- **Schema & Recursive ASTs (`@effect/schema`):** `./repos/effect/packages/schema/src/`
  - Look up `Schema.suspend` (required for the recursive `FilterExpr` Boolean AST), `Schema.TaggedStruct`, `Schema.decodeUnknown`, and JSON Schema generation for LLM structured outputs.
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
2. **Dependency Injection via `Context.Tag` and `Layer`:**
   - Every service (`RegistryDb`, `AccountDb`, `RedisQueue`, `BooleanFilter`, `GmailClient`, `PubSubStream`, `LlmProvider`, `AiRuleWorker`) must define a `Context.Tag` and expose both a `Live` layer and a `Test` layer.
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

- `LlmProviderService` must support switching between `apiMode: "responses"` and `apiMode: "chat_completions"` per endpoint or per rule.
- Both modes must enforce structured JSON output matching the `@effect/schema` definition for `LabellingDecision` (`matched`, `labelsToAdd`, `labelsToRemove`, `archive`, `confidence`, `reasoning`).

### 2.5 Hybrid UI Requirement (`Cmd+K` + Clickable Buttons + Vim Keys)

- Every user action must be executable in **three ways**:
  1. Via the **`Cmd+K` Command Palette** (`src/client/components/CommandPalette.tsx`).
  2. Via an explicit, clickable **Button** in the UI (`src/client/components/ActionToolbar.tsx`) that displays its keyboard shortcut badge (e.g., `[ Archive [E] ]`).
  3. Via a single-key **Vim shortcut** (`src/client/hooks/useVimShortcuts.ts`) when focus is not inside an `<input>`, `<textarea>`, or `[contenteditable]`.

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

---

## 4. Mandatory Phase Execution & Hard Checkpoint Protocol

> **STOP RULE:** The project is structured into **4 sequential phases** (defined in `./PRD.md` Section 5). You must **NEVER** proceed from Phase $N$ to Phase $N+1$ in a single turn or without explicit human approval.

At the end of each phase, you must:

1. Run `bun test` and ensure **0 failures**.
2. Run `bun run typecheck` (`tsc --noEmit`) and ensure **0 type errors**.
3. Present a concise summary of completed files and print the exact **Hard Checkpoint Verification Commands** for the user to run manually.
4. **STOP and wait** for the user to reply `"Approved, proceed to Phase N+1"` (or provide feedback).

### Quick Summary of the 4 Hard Checkpoints

- **🛑 Checkpoint 1 (After Phase 1):** `AccountDb` physical isolation + `BooleanFilter` recursive `AND`/`OR`/`NOT` DSL parser, SQLite compiler, and in-memory evaluator + `tests/phase1-db-and-filter.test.ts`.
- **🛑 Checkpoint 2 (After Phase 2):** Gmail OAuth2, `history.list` delta sync, MIME parser, `sendAs` alias sync, RFC 2822 alias composer, and outbound GCP Pub/Sub `StreamingPull` listener + `tests/phase2-gmail-sync.test.ts`.
- **🛑 Checkpoint 3 (After Phase 3):** Dual `/v1/responses` & `/v1/chat/completions` `LlmProvider`, `AiRuleWorker` with `FilterExpr` pre-conditions, Ghost Labels (`dry_run`), `ai_audit_logs`, and Undo + `tests/phase3-llm-labeller.test.ts`.
- **🛑 Checkpoint 4 (After Phase 4):** React 19 Web UI (`Cmd+K` palette, Action Toolbar buttons with Vim badges, Account Switcher, Visual/DSL Filter Builder, Shadow-DOM reader, Alias Reply Composer) + Tailscale auth middleware + `tests/phase4-api-and-e2e.test.ts`.

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
│   │   ├── main.ts                 # Bun.serve() entry + Effect Layer assembly
│   │   ├── middleware/
│   │   │   └── tailscale-auth.ts   # Tailscale headers / WhoIs verification
│   │   ├── services/
│   │   │   ├── RegistryDb.ts
│   │   │   ├── AccountDb.ts
│   │   │   ├── RedisQueue.ts
│   │   │   ├── BooleanFilter.ts
│   │   │   ├── GmailClient.ts
│   │   │   ├── PubSubStream.ts
│   │   │   ├── LlmProvider.ts
│   │   │   └── AiRuleWorker.ts
│   │   └── routes/
│   │       ├── api.ts
│   │       └── sse.ts
│   ├── client/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── CommandPalette.tsx
│   │   │   ├── ActionToolbar.tsx
│   │   │   ├── AccountSwitcher.tsx
│   │   │   ├── FilterBuilder.tsx
│   │   │   ├── ThreadList.tsx
│   │   │   ├── ThreadReader.tsx
│   │   │   └── AiAuditDrawer.tsx
│   │   └── hooks/
│   │       └── useVimShortcuts.ts
│   └── shared/
│       ├── schemas.ts              # @effect/schema definitions
│       └── errors.ts               # Data.TaggedError definitions
├── tests/
│   ├── helpers/
│   │   └── TestLayers.ts
│   ├── phase1-db-and-filter.test.ts
│   ├── phase2-gmail-sync.test.ts
│   ├── phase3-llm-labeller.test.ts
│   └── phase4-api-and-e2e.test.ts
├── package.json
└── tsconfig.json
```

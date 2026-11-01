# Product Requirements Document (PRD): ZeroEffect

**Project Name:** ZeroEffect — Bespoke AI Email Server & Web Client  
**Runtime & Stack:** Bun (`Bun.serve`, `bun:sqlite`, `Bun.RedisClient`, `bun:test`), Effect-TS (`effect`, `@effect/platform-bun`; schemas from `effect/Schema`), React 19, Tailwind CSS, `cmdk`  
**Deployment Target:** Local Machine / Homelab exposed privately via Tailscale (`tailscale serve`)  
**Companion Document:** See `./AGENTS.md` for coding standards, `./repos/` reference lookup rules, and testing enforcement.

---

## 1. Executive Summary & Vision

**ZeroEffect** is a self-hosted, single-machine email synchronization server, AI auto-labelling engine, and keyboard-first Web client. Built natively on **Bun** and architected with **Effect-TS**, it connects to multiple strictly isolated Gmail accounts (e.g., Personal and Work).

Incoming emails are ingested in real time via outbound Google Cloud Pub/Sub streams (requiring zero public ports or Tailscale Funnel), filtered through a recursive Boolean AST engine (`AND` / `OR` / `NOT`), and classified by OpenAI-compatible LLMs supporting both `/v1/responses` and `/v1/chat/completions`. The web interface combines Superhuman/Vim keyboard navigation with a global `Cmd+K` command palette and explicit, clickable action buttons.

---

## 2. System Architecture

```text
+-----------------------------------------------------------------------------------+
|                        PRIVATE TAILNET (tailscale serve)                          |
|                Web Browser (HTTPS -> 127.0.0.1:3838 via Tailscale)                |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                       ZEROEFFECT BUN SERVER (Bun.serve)                           |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  | REACT 19 + CMDK + TAILWIND WEB CLIENT                                       |  |
|  | - Global Cmd+K Palette (cmdk) for 100% of app actions                       |  |
|  | - Explicit Action Toolbar Buttons with Vim Keycap Badges ([Archive E])      |  |
|  | - Visual & DSL Nested Boolean Filter Builder (AND / OR / NOT)               |  |
|  | - Isolated Account Switcher (Personal <-> Work) + "Send As" Alias Picker    |  |
|  +-----------------------------------------------------------------------------+  |
|                                         | (Typed RPC / REST + SSE Stream)         |
|  +-----------------------------------------------------------------------------+  |
|  | EFFECT-TS APPLICATION LAYER (Context.Service + Layer Dependency Graph)       |  |
|  |                                                                             |  |
|  |  +-----------------------+  +-----------------------+  +-----------------+  |  |
|  |  | AccountSiloService    |  | BooleanFilterService  |  | LlmAiService    |  |  |
|  |  | Per-account isolated  |  | effect/Schema AST    |  | Dual support:   |  |  |
|  |  | bun:sqlite instances  |  | Recursive AND/OR/NOT  |  | /v1/responses & |  |  |
|  |  | (personal.db/work.db) |  | SQL + Memory Eval     |  | /chat/comple... |  |  |
|  |  +-----------------------+  +-----------------------+  +-----------------+  |  |
|  |                                                                             |  |
|  |  +-----------------------------------------------------------------------+  |  |
|  |  | GmailSyncService & PubSubStreamService (Effect.Stream + Schedule)     |  |  |
|  |  | - Outbound GCP Pub/Sub StreamingPull (No Funnel / Zero Public Ports)  |  |  |
|  |  | - Incremental users.history.list + users.settings.sendAs.list         |  |  |
|  |  | - Bun.RedisClient background job queue & pub/sub event bus            |  |  |
|  |  +-----------------------------------------------------------------------+  |  |
+-----------------------------------------------------------------------------------+
```

---

## 3. Functional Requirements

### 3.1 Strict Multi-Account Isolation (`FR-ACCT`)

- **FR-ACCT-01 (Physical SQLite Separation):** Each connected Gmail account (`personal`, `work`) has its own dedicated SQLite database file (`./data/accounts/<account_id>.sqlite`) in WAL mode with FTS5 enabled. Queries for one account can never read or mutate data from another account.
- **FR-ACCT-02 (Instant Context Switching):**
  - URL structure enforces isolation: `/a/:accountId/views/:viewId`.
  - Switching between Personal and Work takes less than 50ms via the top-left Account Switcher pill, keyboard shortcuts (`Alt+1` / `Alt+2`), or `Cmd+K` -> _"Switch Account"_.
- **FR-ACCT-03 (Isolated Background Fibers):** Each account runs its own supervised Effect fiber for Pub/Sub listening, history syncing, and AI rule evaluation.

### 3.2 Gmail Sync, Outbound Pub/Sub & "Send As" Aliases (`FR-GMAIL`)

- **FR-GMAIL-01 (Zero-Funnel Outbound Pub/Sub):**
  - Uses `gmail.users.watch` to publish notifications to a private GCP Pub/Sub topic.
  - The Bun daemon initiates an **outbound** connection to GCP Pub/Sub (`StreamingPull`). No ports are exposed to the public internet, and Tailscale Funnel is not required.
  - Catch-up safety net: at startup and every 10 minutes, every account that has synced before runs an incremental `users.history.list` sync (one request per account when nothing changed). It recovers mail whose notification was lost to a lapsed watch, downtime or a dropped delivery, and keeps mail flowing when Pub/Sub is not configured.
- **FR-GMAIL-02 (Incremental History & MIME Parsing):**
  - Reconciles `messagesAdded`, `messagesDeleted`, `labelsAdded`, and `labelsRemoved` from `history.list`.
  - Parses MIME structures into sanitized HTML (for Shadow DOM rendering) and clean Markdown (for LLM token efficiency).
- **FR-GMAIL-03 ("Send As" Alias Sync & Smart Reply):**
  - Syncs `users.settings.sendAs.list` into the account's `send_as_aliases` table (storing `sendAsEmail`, `displayName`, `replyToAddress`, `signatureHtml`, `isPrimary`, `isDefault`).
  - When replying to an email, inspects the incoming message's `Delivered-To`, `To`, and `Cc` headers and automatically selects the matching verified `Send As` alias.
  - Users can change the active alias in the composer via a dropdown button or `Cmd+K` -> _"Change Sender Alias"_.

### 3.3 Nested Boolean AST Filter Engine (`FR-FILTER`)

- **FR-FILTER-01 (Arbitrary Nesting of `AND`, `OR`, `NOT`):**
  - Supports deeply nested Boolean logic for both **Saved Inbox Views** and **AI Rule Pre-Conditions**, e.g.:
    `is:unread AND (label:"Label A" OR label:"Label B" OR label:"Label C") AND NOT from:"noreply@"`
- **FR-FILTER-02 (Dual Evaluation Targets):**
  - **SQLite Compiler:** Compiles `FilterExpr` into parameterized SQL (`WHERE (is_unread = 1 AND (EXISTS (...) OR EXISTS (...)))`) using `json_each(threads.labels_json)`.
  - **In-Memory Predicate:** Evaluates `FilterExpr` directly against a hydrated `Thread` object in memory before deciding whether to invoke an LLM rule.
- **FR-FILTER-03 (Synchronized Visual & Text DSL Builder):**
  - Users can either type the query in a text bar with syntax highlighting/autocomplete OR build nested groups visually (`[+ Add Condition]`, `[+ Add AND/OR Group]`). Both views read/write the exact same `FilterExpr` AST.
- **FR-FILTER-04 (Full-Text Search):** _(implemented, Phase 6)_
  - **Syntax:** bare words and quoted phrases in the DSL are search terms, combinable with every other condition: `invoice AND from:"acme" AND NOT label:Paid`, `"quarterly report" OR budget`. Conditions side by side are ANDed (`invoice from:acme`); quoted keywords and colons are search text (`"not"`, `"from:x"`); search text needs at least one letter or digit. `text:"…"` is the explicit form (and what the formatter writes back). A new `FilterExpr` node, `{ _tag: "Text", value }`, carries them; the visual builder offers it as a "Text contains" condition.
  - **Scope:** a thread matches when any of its messages matches, across subject, sender and body (`messages_fts`, which sync already maintains). Attachment file names are included (inline images excluded); attachment contents are not.
  - **Matching rule (one definition, both targets):** the value is split into tokens with FTS5's `unicode61 remove_diacritics 2` rules (case-insensitive, diacritics dropped from Latin letters, split on non-alphanumerics). The browser and server use a per-code-point table generated from SQLite itself (`scripts/generate-unicode61-table.ts` → `src/shared/unicode61Table.ts`); a test fails if it drifts from the running SQLite. Every token must be the **prefix of a word** in the thread's text, in any order; a quoted phrase additionally requires its tokens consecutively. Prefix matching lets Korean words match with particles attached (`보고서` matches `보고서를`).
  - **SQLite compiler:** `threads.id IN (SELECT thread_id FROM messages_fts WHERE messages_fts MATCH ?)`, with each token bound as a quoted prefix query (`"invoi"*`), never interpolated.
  - **In-memory evaluator:** AI rule pre-conditions evaluate the same rule against the thread's message text, tokenized identically (`FilterThread` gains the thread's text, loaded only when a pre-condition contains a `Text` node).
  - **Equivalence law:** the AGENTS.md §3.3 matrix gains `Text` expressions (single words, prefixes, phrases, Hangul, accented and mixed-case text, `NOT` and nested combinations); `evaluateInMemory(E, T) ≡ querySqliteWithCompiledAst(E, T)` must keep holding for all of them.
  - **Cost:** the index is already written on every sync. A query is a local FTS5 lookup (milliseconds at tens of thousands of messages) and makes no Gmail calls. Search covers mail synced locally, not the whole Gmail mailbox; older mail is reached by raising the initial import size.
  - **UI:** typing plain words in the filter bar searches the current view; `/` focuses it; "Save as Split View" saves searches like any other filter.

### 3.4 Dual-Endpoint OpenAI-Compatible Auto-Labeller (`FR-LLM`)

- **FR-LLM-01 (Support Both `Responses` and `Chat Completions`):**
  - Each configured LLM provider endpoint supports choosing between:
    - **`responses` (`POST /v1/responses`)**: Uses `instructions`, `input`, and `text.format` (`json_schema`) for structured output.
    - **`chat_completions` (`POST /v1/chat/completions`)**: Uses `messages` (`system` + `user`) and `response_format` (`json_schema`) for compatibility with Ollama, vLLM, LiteLLM, OpenRouter, and OpenAI.
- **FR-LLM-02 (Rule Pipeline & Dry-Run Mode):**
  - Rules are stored per account as JSON (`data/accounts/<account_id>.rules.json`) in Inbox Zero's export shape: `name`, `instructions`, `enabled`, `automate`, `runOnThreads`, `systemType`, static `from`/`to`/`subject`/`body` conditions with `conditionalOperator`, an optional `precondition` (Boolean DSL), and `LABEL` / `ARCHIVE` / `MARK_READ` actions. Inbox Zero exports are imported per account with `scripts/import-rules.ts`.
  - When new mail arrives in a thread (incremental sync), or on demand:
    1. Filter enabled rules in memory: `precondition`, static conditions (AND gates the AI, OR matches without it), and `runOnThreads` (on follow-up messages, first-message-only rules are skipped, and re-applied for free if they matched earlier).
    2. The four conversation status rules (`TO_REPLY`, `AWAITING_REPLY`, `FYI`, `ACTIONED`) are offered as one "Conversations" option; no-reply senders never get one.
    3. Make **one** structured LLM call over the remaining rules and thread: `{ reasoning, matchedRules: [{ ruleName, isPrimary }], noMatchFound, conversationStatus }`. No call is made when nothing needs the AI.
    4. Apply the matched rules' actions with one `users.threads.modify` call; a new conversation status removes the other status labels. Rules with `automate: false` store **Suggested Ghost Labels** instead, for 1-key approval (`y`/`n`).
    5. Record the run in `ai_audit_logs` (one row per run; the latest run can be undone).

### 3.5 Web UI: `Cmd+K` Command Palette, Action Buttons & Vim Keys (`FR-UI`)

- **FR-UI-01 (Omnipresent `Cmd+K` Command Palette):**
  - Built on `cmdk`, accessible via `Cmd+K` / `Ctrl+K` or by clicking the top-bar **`[ ⌘K Command Palette ]`** button.
  - Exposes every action in the system with fuzzy search and nested sub-menus:
    - _Account_: Switch to Personal, Switch to Work, Trigger Sync, Manage "Send As" Aliases.
    - _Thread_: Archive (`e`), Apply/Remove Label (`l`), Run AI Labeller (`a`), Accept Ghost Label (`y`), Reject Ghost Label (`n`), Reply (`r`), Reply Switching Alias (`Shift+r`), Mark Read/Unread (`u`), Undo Last AI Action (`z`).
    - _Filter & Views_: Search or Filter by Boolean DSL (`/`), Create New Saved Split View, Jump to Label.
    - _AI Rules_: Create Rule, Toggle Rule Dry-Run, Inspect Thread AI Audit Log (`w`).
- **FR-UI-02 (First-Class Action Buttons + Vim Keybindings):**
  - Every major action is represented by a physical, clickable UI button in the persistent Action Toolbar AND a single-key Vim shortcut when not typing in an input.
  - Each button displays its shortcut as a subtle keycap badge:
    `[ Archive [E] ]` `[ Label [L] ]` `[ Reply [R] ]` `[ Run AI [A] ]` `[ AI Audit [W] ]`
- **FR-UI-03 (Tailscale Service Integration):**
  - Server binds to `127.0.0.1:3838` and is exposed to the private Tailnet via `tailscale serve --bg 3838`.
  - Reads `Tailscale-User-Login` / `Tailscale-User-Name` headers injected by `tailscale serve` for zero-password authentication across trusted Tailnet devices.

### 3.6 Everyday Mail Handling (`FR-MAIL`)

- **FR-MAIL-01 (Attachments):**
  - Sync records each message's attachments (`messages.attachments_json`: part id, file name, MIME type, size, Content-ID, inline flag, Gmail attachment id); messages stored before this are filled in when their thread is first opened.
  - The reader lists attachments as download chips and shows `cid:` inline images. Downloads go through `GET /api/a/:accountId/messages/:messageId/attachments/:partId`, scoped to the account's silo, always as `Content-Disposition: attachment` with `nosniff` and a sandbox CSP; only raster images may be served inline.
  - Replies, new messages and forwards accept attachments (file picker or drag and drop), up to Gmail's 25 MB per message. Messages with attachments are `multipart/mixed` and are sent through Gmail's upload endpoint (`uploadType=multipart`).
- **FR-MAIL-02 (Forward):** forwards a thread's newest message in the same Gmail conversation with Gmail's "Forwarded message" header, the original HTML, and the original attachments (each can be left out; inline images keep their Content-ID).
- **FR-MAIL-03 (Trash & Spam):** thread actions that add `TRASH` / `SPAM` (and leave the inbox), with restore; built-in Trash and Spam views listed after split views, without digit keys.
- **FR-MAIL-04 (Bulk Actions):** threads are checked with `Space`, shift-click ranges, `*` (all loaded) and `X` (clear); while any are checked, every thread action applies to all of them through `POST /threads/bulk`, which calls `messages.batchModify` (1,000 messages per request) for only the messages the action changes. "Mark all as read" (`U`) covers the whole current view and query, not just the loaded page.
- **FR-MAIL-05 (Labels & Aliases):** labels can be created, renamed (renames follow into saved views and AI rules) and deleted from the palette; the "Send As aliases" page lists every alias with its verification status, starts a message from one, and refreshes them from Gmail.

---

## 4. Database Schemas (`bun:sqlite`)

### 4.1 Global Registry Database (`./data/registry.sqlite`)

```sql
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,                 -- e.g., 'personal', 'work'
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    color_theme TEXT NOT NULL,           -- Visual indicator in UI header (e.g., 'blue', 'emerald')
    oauth_tokens_enc BLOB NOT NULL,      -- Encrypted access + refresh tokens
    pubsub_topic TEXT,
    watch_expiration_ts INTEGER,
    last_history_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE llm_endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,                  -- e.g., 'Local vLLM', 'OpenAI GPT-4.1', 'OpenRouter'
    base_url TEXT NOT NULL,              -- e.g., '[https://api.openai.com/v1](https://api.openai.com/v1)'
    api_key_enc BLOB NOT NULL,
    model_id TEXT NOT NULL,
    api_mode TEXT NOT NULL CHECK (api_mode IN ('responses', 'chat_completions')),
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    max_concurrency INTEGER NOT NULL DEFAULT 3
);
```

### 4.2 Per-Account Isolated Database (`./data/accounts/<account_id>.sqlite`)

```sql
CREATE TABLE labels (
    id TEXT PRIMARY KEY,                 -- Gmail label ID
    name TEXT UNIQUE NOT NULL,           -- e.g., 'INBOX', 'AI/Receipts', 'Label A'
    type TEXT NOT NULL,                  -- 'system' | 'user'
    color_bg TEXT,
    color_text TEXT
);

CREATE TABLE send_as_aliases (
    send_as_email TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    reply_to_address TEXT,
    signature_html TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    verification_status TEXT NOT NULL
);

CREATE TABLE threads (
    id TEXT PRIMARY KEY,                 -- Gmail threadId
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL,
    last_message_at INTEGER NOT NULL,
    is_unread INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    sender_summary TEXT NOT NULL,
    delivered_to_alias TEXT,             -- Matched against send_as_aliases
    labels_json TEXT NOT NULL,           -- JSON array of label names: ["Label A", "AI/Urgent"]
    ghost_labels_json TEXT NOT NULL DEFAULT '[]', -- Pending dry-run AI suggestions
    ai_status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'processed' | 'skipped' | 'error'
    ai_evaluated_through INTEGER,                 -- date_ts of the newest message the AI has classified
    otp_code TEXT                                 -- One-time code found in the newest message
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,                 -- Gmail messageId
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    from_address TEXT NOT NULL,
    to_addresses_json TEXT NOT NULL,
    cc_addresses_json TEXT NOT NULL,
    delivered_to TEXT,
    date_ts INTEGER NOT NULL,
    body_markdown TEXT NOT NULL,
    body_html_sanitized TEXT NOT NULL,
    raw_headers_json TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]', -- This message's labels; threads.labels_json is their union (Gmail semantics)
    body_html TEXT,                      -- Original HTML (sanitized by the client); NULL for plain text
    attachments_json TEXT                -- Attachment metadata (FR-MAIL-01); NULL = not yet recorded
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
    thread_id UNINDEXED,
    subject,
    from_address,
    body_markdown
);

CREATE TABLE saved_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    filter_ast_json TEXT NOT NULL,       -- Serialized Effect Schema FilterExpr
    dsl_string TEXT NOT NULL             -- e.g., 'is:unread AND (label:"A" OR label:"B")'
);

-- AI rules are not stored in SQLite: see data/accounts/<account_id>.rules.json (FR-LLM-02).

CREATE TABLE ai_audit_logs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,               -- 'auto' (new mail) | 'manual'
    rule_names_json TEXT NOT NULL,       -- Rules applied in this run
    conversation_status TEXT,            -- TO_REPLY | AWAITING_REPLY | FYI | ACTIONED
    endpoint_id TEXT,                    -- NULL when no LLM call was needed
    api_mode_used TEXT,
    model_used TEXT,
    reasoning TEXT NOT NULL,
    actions_applied_json TEXT NOT NULL,  -- { labelsAdded, labelsRemoved, ghostLabelsAdded, ghostLabelsBefore }
    undoable INTEGER NOT NULL,
    reverted INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
```

---

## 5. Phased Implementation Roadmap & Hard Checkpoints

### Phase 1: Foundation, Account Silo DBs & Boolean AST Engine

- **Scope:**
  - Workspace setup (`package.json`, `tsconfig.json`, `./repos/` setup script).
  - `RegistryDbService` and `AccountDbService` with isolated SQLite files (`personal` vs `work`).
  - `BooleanFilterService`: DSL parser (`is:unread AND (label:A OR label:B OR label:C)`), Effect Schema AST, SQLite query compiler (`json_each`), and in-memory predicate evaluator.
- **🛑 HARD CHECKPOINT 1:**
  - Run `bun test tests/phase1-db-and-filter.test.ts` (verifying 100% SQL-to-memory parity across 15+ nested `AND`/`OR`/`NOT` expressions and strict DB isolation).
  - Run `bun run scripts/cli-filter-demo.ts 'is:unread AND (label:A OR label:B OR label:C)'` to manually inspect generated AST and SQL.

### Phase 2: Gmail Sync, "Send As" Aliases & Outbound Pub/Sub

- **Scope:**
  - Google OAuth2 flow for isolated accounts.
  - `GmailSyncService`: Initial hydration + incremental `users.history.list` sync + MIME parser (HTML sanitization + Markdown conversion) + `users.settings.sendAs.list` sync.
  - `PubSubListenerService`: Outbound GCP Pub/Sub `StreamingPull` stream feeding `RedisQueueService`.
  - `SendAsComposerService`: RFC 2822 raw email builder with smart `Delivered-To` alias matching.
- **🛑 HARD CHECKPOINT 2:**
  - Run `bun test tests/phase2-gmail-sync.test.ts`.
  - Manually authenticate **Personal** and **Work** Gmail accounts in dev mode, confirm isolated `.sqlite` files populate, and send a test email to verify real-time outbound Pub/Sub ingestion.

### Phase 3: Dual-Mode OpenAI Auto-Labeller (`/v1/responses` & `/v1/chat/completions`)

- **Scope:**
  - `LlmProviderService` supporting both `/v1/responses` and `/v1/chat/completions` with structured JSON schema outputs.
  - `AiRuleWorkerService`: Filters the account's JSON rules (preconditions, static conditions, `runOnThreads`) -> one structured LLM call per thread -> applies Gmail labels (or Ghost Labels when `automate` is false) -> writes `ai_audit_logs`.
  - One-step `undoAiAction` reversal service.
- **🛑 HARD CHECKPOINT 3:**
  - Run `bun test tests/phase3-llm-labeller.test.ts`.
  - Manually run a live AI rule against a real thread using both `responses` and `chat_completions` modes, inspect `ai_audit_logs`, and verify label sync on Gmail.

### Phase 4: Web UI — `Cmd+K` Palette, Action Buttons, Vim Keys & Tailscale Service

- **Scope:**
  - React 19 UI with isolated Account Switcher (`Alt+1`/`Alt+2`).
  - Global `Cmd+K` Command Palette (`cmdk`) covering 100% of app actions.
  - Persistent Action Toolbar with explicit clickable buttons + keycap badges (`[ Archive [E] ]`, `[ Label [L] ]`, `[ Reply [R] ]`, `[ Run AI [A] ]`) paired with Vim navigation (`j`/`k`/`e`/`l`/`r`/`a`/`w`/`u`).
  - Synchronized Visual & DSL Boolean Filter Builder + "Save as Split View".
  - Shadow-DOM email reader, AI Audit Drawer, and "Send As" alias selector in the reply composer.
  - Tailscale `WhoIs` / header authentication middleware and `tailscale serve` scripts.
- **🛑 HARD CHECKPOINT 4:**
  - Run full `bun test` suite across Phases 1–4.
  - Expose via `tailscale serve --bg 3838` and perform end-to-end manual acceptance across Personal and Work accounts.

### Phase 5: Everyday Mail Handling & Keyboard Coverage _(implemented)_

- **Scope:**
  - Catch-up `history.list` sync at startup and every 10 minutes (FR-GMAIL-01).
  - Attachments in and out, Forward, Trash & Spam, bulk actions and "Mark all as read" (FR-MAIL).
  - More palette commands and keys: Open/Close (`o`), first/last thread (`{` `}`), previous/next message (`[` `]`), check (`Space`), Forward (`F`), Trash (`#`), Spam (`!`), Jump to label (`L`), Open in Gmail (`O`), Copy link (`Y`), shortcut cheat sheet (`?`), label management and Send As aliases.
  - Text inputs opt out of password-manager autofill, and `Cmd+K` is captured before extension listeners.
- **🛑 HARD CHECKPOINT 5:**
  - Run `bun test` (including `tests/phase5-mail-features.test.ts`) and `bun run typecheck`.
  - Manually: open a thread with attachments and inline images, forward it with one attachment left out, trash and restore a thread, check several threads and archive them, and run "Mark all as read" on a view.

### Phase 6: Full-Text Search _(implemented)_

- **Scope:**
  - `Text` node in `FilterExpr` (bare words, quoted phrases, `text:"…"`) in the shared parser, formatter and visual builder (FR-FILTER-04).
  - SQLite compilation to `messages_fts MATCH` with bound prefix queries; in-memory evaluation with the identical tokenizer for AI rule pre-conditions.
  - Attachment file names added to `messages_fts`.
- **🛑 HARD CHECKPOINT 6:**
  - Run `bun test` with the AST equivalence matrix extended to `Text` expressions (AGENTS.md §3.3), and `bun run typecheck`.
  - Manually: search a word, a prefix, a quoted phrase and a Korean word with a particle in the filter bar; combine a search with `label:` and `NOT`; save one as a split view.

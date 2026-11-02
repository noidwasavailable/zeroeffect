# ZeroEffect

A self-hosted Gmail client that runs on your own machine. It syncs a **Personal** and a **Work** Gmail account into separate local SQLite databases, labels new mail with any OpenAI-compatible LLM, and gives you a keyboard-first web client.

Built with [Bun](https://bun.sh) and [Effect](https://effect.website).

Heavily inspired by [Inbox Zero](https://github.com/elie222/inbox-zero).

## Features

- **Two isolated accounts.** Personal and Work each get their own database file. Switch between them with `Alt+1` / `Alt+2`.
- **Keyboard first.** Every action is in the `Cmd+K` command palette, has a clickable button, and most also have a single Vim-style key (`j`/`k`, `e` to archive, `r` to reply…). Press `?` for the full list.
- **Boolean filters and split views.** Write queries like `is:unread AND (label:Work OR from:boss) AND NOT label:Newsletters` as text or build them visually, then save them as views.
- **Full-text search.** Search subjects, senders, bodies and attachment names locally with SQLite FTS5. Prefix matching works for Korean too (`보고서` matches `보고서를`).
- **AI auto-labelling.** Each new thread gets one structured LLM call over your rule list. Rules can label, archive or mark as read. Dry-run rules suggest "ghost labels" that you accept with `y` or reject with `n`. Every run is logged and the latest one can be undone (`z`). You can import rules from an [Inbox Zero](https://github.com/elie222/inbox-zero) export, and both `/v1/responses` and `/v1/chat/completions` endpoints are supported (OpenAI, OpenRouter, Ollama, vLLM, LiteLLM…).
- **Everyday mail.** Reply (the matching Send As alias is chosen automatically), reply all, forward, new messages, attachments in and out, trash, spam, stars, labels, bulk actions and "Mark all as read".
- **Real-time sync (optional).** New mail can arrive through Gmail push notifications over an _outbound_ Google Cloud Pub/Sub connection, so nothing has to be exposed to the internet. Without Pub/Sub, a catch-up sync runs at startup and every 10 minutes.

## Try it without a Gmail account

```sh
bun install
bun run demo
```

Then open <http://127.0.0.1:3001/>. The demo uses seeded in-memory accounts and a mock Gmail API, and writes nothing to disk. Once you have a `.env`, the demo uses its `PORT` instead (3838), so stop the real server first.

## Set it up for your own mail

You need [Bun](https://bun.sh) 1.4 or newer, a Google account, and a Google Cloud project (the free tier is enough). Docker is needed only for the optional Pub/Sub step.

### 1. Create a Google OAuth client

Each user creates their own OAuth client. ZeroEffect doesn't ship one.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or pick a project and enable the **Gmail API**.
2. Under **Google Auth Platform**:
   - **Branding:** set the app name (for example "ZeroEffect"). This is the name the Google consent screen shows.
   - **Audience:** add the Gmail addresses you'll connect as test users.
   - **Clients:** create a **Web application** client with these two authorized redirect URIs:

     ```text
     http://127.0.0.1:3838/auth/google/callback
     http://127.0.0.1:3838/auth/google/pubsub/callback
     ```

> [!IMPORTANT]
> While the app's publishing status is **Testing**, Google expires its sign-ins after 7 days and you'll have to reconnect. To avoid that, set the status to **In production**. An unverified app you use yourself works fine; you'll see a one-time warning screen.

### 2. Configure `.env`

```sh
cp .env.example .env
```

Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then generate the key that encrypts your stored OAuth tokens and LLM API keys:

```sh
bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Put the output in `OAUTH_ENCRYPTION_KEY`. Keep `.env` private, and don't lose or change this key: without it, stored credentials can't be decrypted.

### 3. Run it and connect your accounts

```sh
bun install
bun run dev
```

Open <http://127.0.0.1:3838/>. It shows the setup page until an account is connected. Connect Personal and/or Work, click **Sync now**, then open the client. You can come back to setup anytime with `G` or from the palette.

All data lives in `./data/`: `registry.sqlite` holds accounts and encrypted tokens, and `accounts/personal.sqlite` and `accounts/work.sqlite` hold each account's mail. The folder is git-ignored.

### 4. Turn on AI labelling (optional)

Press `,` (**AI rules & endpoints**) in the client to:

1. Add an LLM endpoint: base URL, model, API mode (`responses` or `chat_completions`) and API key. The key is stored encrypted.
2. Pick that endpoint for the account and write rules. Each rule has instructions, optional conditions or a filter pre-condition, and actions.

New mail is then labelled automatically. Press `a` to run the rules on the selected thread, and `w` to see why a thread got its labels. The AI rules are intentionally compatible with Inbox Zero so that you may import it directly into ZeroEffect (or export back out if you didn't like ZeroEffect).

You can also do this from the command line:

```sh
# Register an endpoint
LLM_API_KEY=sk-... bun run scripts/llm-endpoint.ts --id openai \
  --base-url https://api.openai.com/v1 --model gpt-5-mini --api-mode responses

# Import an Inbox Zero rules export into one account
bun run scripts/import-rules.ts personal export.json --endpoint openai
```

Rules are saved per account in `data/accounts/<account>.rules.json`, and you can edit that file by hand.

### 5. Real-time notifications with Pub/Sub (optional)

Without this step, new mail shows up within 10 minutes, or right away when you press `S` to sync.

1. In the same Google Cloud project, enable the **Pub/Sub API**, create a **topic** and a **pull subscription** on it.
2. Grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on the topic, and grant your Google account the **Pub/Sub Subscriber** role on the subscription.
3. Set `GCP_PROJECT_ID`, `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUBSUB_SUBSCRIPTION` in `.env`. Use the short IDs, not the full `projects/…` names.
4. Restart the server and click **Connect Pub/Sub account** on the setup page.

Notifications are queued in Redis. If nothing answers at `REDIS_URL`, the server starts a Valkey container (`zeroeffect-valkey`) with Docker and stops it on exit. The header status button (`H`) shows the Pub/Sub state and any background problems.

## Run it in the background (macOS)

```sh
bun run zeroeffect install   # install a launchd agent: starts now, at login, and after crashes
bun run zeroeffect status    # launchd state, Pub/Sub state, background problems
bun run zeroeffect logs -f   # follow the logs (stored in ~/Library/Logs/zeroeffect)
bun run zeroeffect restart   # after pulling changes
bun run zeroeffect uninstall
```

## Use it from other devices

ZeroEffect has **no login of its own**, so it only listens on `127.0.0.1`. If you use [Tailscale](https://tailscale.com), you can expose it to your other devices on the same Tailscale network. On the machine running ZeroEffect:

```sh
tailscale serve --service=svc:mail --https=443 127.0.0.1:3838
```

> [!WARNING]
> Don't expose it to the public internet. Use `tailscale serve`, never `tailscale funnel` or port forwarding: anyone who can reach the server can read and send your mail.
> Similarly, if other people on your tailnet can access this service, they will be able to read all your messages and even send one on your behalf!

Google only accepts loopback OAuth callbacks, so connect accounts from the machine running the server, at `http://127.0.0.1:3838/setup`, or add the Tailscale FQDN in the Google Cloud OAuth client as an additional redirect URI, such as `https://<svc-name>.tail-scale.ts.net/setup`, etc.

## Filter and search syntax

| Syntax                                                 | Matches                                               |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `invoice`, `"quarterly report"`                        | Threads containing the word (prefix) or exact phrase  |
| `is:unread` / `is:read` / `is:starred` / `is:archived` | Thread state                                          |
| `label:Work`, `label:"Label A"`                        | Threads with that label                               |
| `from:acme`, `subject:invoice`                         | Sender or subject contains the text                   |
| `AND`, `OR`, `NOT`, `( … )`                            | Combine conditions. Conditions side by side are ANDed |

Press `/` to focus the filter bar and `v` to save the current query as a split view.

## Development

```sh
bun test               # offline test suite (mock Gmail and LLM servers, in-memory SQLite)
bun run typecheck
bun run scripts/cli-filter-demo.ts 'is:unread AND label:INBOX'   # print a filter's AST and SQL
scripts/setup-repos.sh # clone the Effect and Inbox Zero reference repos into ./repos
```

- [`PRD.md`](./PRD.md) covers the architecture, database schemas and feature specs.
- [`AGENTS.md`](./AGENTS.md) has the coding rules and repository layout.

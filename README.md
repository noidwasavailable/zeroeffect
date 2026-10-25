# zeroeffect

# ZeroEffect

ZeroEffect is an in-progress self-hosted Gmail client. The current runnable UI is a **local development account setup screen** for binding Personal and Work Gmail accounts and verifying initial/incremental sync. It is not yet the Phase 4 mail client.

## Connect Gmail accounts locally

1. In your own Google Cloud project, enable the Gmail API and create an OAuth 2.0 **Web application** client. Under **Google Auth Platform → Branding**, set the app name to **ZeroEffect**. The consent-screen app name comes from this Google Cloud project, not this repository; verify `GOOGLE_CLIENT_ID` belongs to that project (do not reuse an Inbox Zero client). Add this exact authorized redirect URI:

   ```text
   http://127.0.0.1:3000/auth/google/callback
   http://127.0.0.1:3000/auth/google/pubsub/callback
   ```

   Configure the OAuth consent screen for testing and add the Google accounts you plan to connect as test users. Gmail binding requests Gmail modify, send, and basic settings access; Pub/Sub authorization separately requests the Pub/Sub scope.

2. Copy `.env.example` to `.env`, then add the client ID and secret. Generate a private encryption key for persisted OAuth tokens:

   ```sh
   bun -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("hex"))'
   ```

   Put the generated 64-character hex value in `OAUTH_ENCRYPTION_KEY`. Keep `.env` and this key private; changing or losing the key prevents decrypting credentials already stored in the registry database.

3. Install dependencies and start the local server:

   ```sh
   bun install
   bun run dev
   ```

4. Open `http://127.0.0.1:3000`, connect Personal and Work, and use **Sync now** to verify Gmail profile access, message hydration/history updates, and Send As alias sync. If you open the page as `localhost`, it redirects the UI and OAuth start to the hostname configured in `GOOGLE_REDIRECT_URI`, so the browser's state cookie stays on the callback host. Keep `PORT` aligned with the port in that redirect URI. Data is stored in `./data/registry.sqlite` and separate `./data/accounts/personal.sqlite` / `work.sqlite` files. Stop with `Ctrl+C` when done.

The development server refuses non-loopback binds and the sync endpoint checks same-origin requests. Do not expose this temporary setup UI to a network or put real credentials in source control.

## Optional GCP Pub/Sub pull binding

The server can open an outbound Google Cloud Pub/Sub StreamingPull connection and enqueue notification payloads in the local Redis list `gmail:notifications`. It obtains a separate Pub/Sub refresh token through browser OAuth and stores it encrypted in the local registry database; it does not use ADC, `gcloud`, or the Personal/Work Gmail tokens. To enable it:

1. In the GCP project used for Gmail, enable the Pub/Sub API, create a topic and a pull subscription, grant the Gmail push service account `gmail-api-push@system.gserviceaccount.com` permission to publish to the topic, and grant the Google account you intend to authorize `roles/pubsub.subscriber` on the subscription. Topic, subscription, and IAM setup remain external Cloud Console tasks.
2. Add the Pub/Sub callback URI shown above to the OAuth Web client. Set `GCP_PROJECT_ID` and `GMAIL_PUBSUB_SUBSCRIPTION` in `.env` (the subscription's short ID, not its full resource path). Set `REDIS_URL` if Redis is not listening at the default `redis://127.0.0.1:6379`, then start `bun run dev`.
3. Open `http://127.0.0.1:3000` and use **Connect Pub/Sub account**. Sign in as the Google account with subscriber access and approve the Pub/Sub scope. ZeroEffect uses that account's OAuth refresh token to create an authorized Pub/Sub client; no external CLI authentication is required. Keep `PORT` aligned with both loopback callback URIs.
4. Gmail notifications are only published while a Gmail `users.watch` is active for the topic. This development server does not yet create or renew Gmail watches, and the notification queue does not yet trigger account history sync by itself. A successful Gmail sync or mocked StreamingPull test is therefore not evidence of live Pub/Sub delivery. Keep the server loopback-only; verify a real notification in your own GCP setup before relying on this binding.

The listener enqueues each Pub/Sub notification before acknowledging it, so Redis enqueue failures leave messages unacknowledged for redelivery. Automatic labeling is not part of this Phase 2 binding.

## Checks

```sh
bun test
bun run typecheck
```

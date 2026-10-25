# zeroeffect

# ZeroEffect

ZeroEffect is an in-progress self-hosted Gmail client. The current runnable UI is a **local development account setup screen** for binding Personal and Work Gmail accounts and verifying initial/incremental sync. It is not yet the Phase 4 mail client.

## Connect Gmail accounts locally

1. In Google Cloud Console, enable the Gmail API and create an OAuth 2.0 **Web application** client. Add this exact authorized redirect URI:

   ```text
   http://127.0.0.1:3000/auth/google/callback
   ```

   Configure the OAuth consent screen for testing and add the Google accounts you plan to connect as test users. The app requests Gmail modify, send, and basic settings access.

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

4. Open `http://127.0.0.1:3000`, connect Personal and Work, and use **Sync now** to verify Gmail profile access, message hydration/history updates, and Send As alias sync. Data is stored in `./data/registry.sqlite` and separate `./data/accounts/personal.sqlite` / `work.sqlite` files. Stop with `Ctrl+C` when done.

The development server refuses non-loopback binds and the sync endpoint checks same-origin requests. Do not expose this temporary setup UI to a network or put real credentials in source control. The outbound Pub/Sub transport still requires deployment-specific GCP configuration; this screen verifies Gmail sync but does not claim live Pub/Sub delivery.

## Checks

```sh
bun test
bun run typecheck
```

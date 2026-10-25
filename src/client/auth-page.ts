/** A small local account-binding shell. The #app root is intentionally stable for the Phase 4 UI. */
export const renderAccountBindingPage = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>ZeroEffect · Connect accounts</title>
  <style>
    :root { color-scheme: light dark; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background: #f5f6f8; color: #20242c; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    .shell { max-width: 920px; margin: 0 auto; padding: 24px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0 28px; border-bottom: 1px solid #d8dce3; }
    .brand { margin: 0; font-size: 1.25rem; letter-spacing: -.03em; }
    .environment { color: #596273; font-size: .875rem; }
    h2 { margin: 32px 0 8px; font-size: 1.5rem; letter-spacing: -.03em; }
    .intro { max-width: 62ch; color: #596273; margin: 0 0 24px; }
    .accounts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 16px; }
    .account { display: flex; flex-direction: column; min-height: 220px; padding: 22px; border: 1px solid #d8dce3; border-radius: 14px; background: #fff; box-shadow: 0 2px 8px #16223a0a; }
    .account h3 { margin: 0; font-size: 1.1rem; }
    .email { min-height: 28px; margin: 10px 0 16px; color: #596273; overflow-wrap: anywhere; }
    .state { min-height: 24px; margin: 0 0 16px; font-size: .9rem; color: #596273; }
    .sync-options { display: grid; gap: 6px; margin: 0 0 14px; color: #596273; font-size: .9rem; }
    .sync-options input { width: 9rem; min-height: 38px; padding: 6px 9px; border: 1px solid #aeb6c4; border-radius: 7px; background: transparent; color: inherit; font: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: auto; }
    button, .button { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 8px 14px; border: 1px solid #263d7a; border-radius: 8px; background: #263d7a; color: #fff; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
    button.secondary { background: transparent; color: #263d7a; }
    button:disabled { opacity: .6; cursor: wait; }
    .notice { padding: 12px 14px; border-radius: 8px; background: #eaf0ff; color: #263d7a; }
    .notice.error { background: #ffeded; color: #8b2020; }
    .footnote { margin: 28px 0 0; color: #687184; font-size: .85rem; }
    @media (prefers-color-scheme: dark) {
      :root { background: #14171d; color: #edf0f5; }
      .topbar, .account { border-color: #343a46; }
      .account { background: #1c2028; box-shadow: none; }
      .environment, .intro, .email, .state, .sync-options, .footnote { color: #aab2c1; }
      .sync-options input { border-color: #596273; }
      button, .button { border-color: #a8baff; background: #a8baff; color: #171c2a; }
      button.secondary { background: transparent; color: #c5d0ff; }
      .notice { background: #202b46; color: #c5d0ff; }
      .notice.error { background: #432323; color: #ffd0d0; }
    }
  </style>
</head>
<body>
  <div id="app" class="shell">
    <header class="topbar">
      <h1 class="brand">ZeroEffect</h1>
      <span class="environment">Local development · loopback only</span>
    </header>
    <main>
      <h2>Connect Gmail accounts</h2>
      <p class="intro">Bind Personal and Work separately. Each account is stored in its own database silo. Sync imports the latest conversations up to your chosen limit as a background job and shows progress here.</p>
      <p id="notice" class="notice" role="status" aria-live="polite" hidden></p>
      <section id="accounts" class="accounts" aria-label="Gmail account bindings"></section>
      <h2>Google Cloud Pub/Sub</h2>
      <p class="intro">Authorize a Google account in this browser for the local Pub/Sub listener. Create the topic and subscription and grant that account Pub/Sub Subscriber access in Google Cloud Console.</p>
      <section id="pubsub" class="account" aria-label="Pub/Sub authorization"></section>
      <p class="footnote">This local setup screen does not expose the full mail client or Tailscale authentication. Keep the server bound to localhost and never commit your OAuth credentials.</p>
    </main>
  </div>
  <script>
    const slotNames = { personal: "Personal", work: "Work" };
    const accountsRoot = document.getElementById("accounts");
    const pubsubRoot = document.getElementById("pubsub");
    const notice = document.getElementById("notice");
    const setNotice = (message, isError = false) => {
      notice.textContent = message;
      notice.classList.toggle("error", isError);
      notice.hidden = !message;
    };
    const button = (label, className, action) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      if (className) element.className = className;
      element.addEventListener("click", action);
      return element;
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const describeJob = (job) => {
      if (job.status === "failed") return job.error || "Sync failed.";
      if (job.status === "completed") {
        const result = job.result;
        return result
          ? "Sync complete: " + job.progress.conversationsCompleted + " conversations, " + result.messagesUpserted + " messages updated and " + result.messagesDeleted + " deleted."
          : "Sync complete.";
      }
      if (job.progress.stage === "listing_conversations") return "Finding the latest conversations (up to " + job.initialConversationLimit + ")…";
      if (job.progress.stage === "importing_conversations") {
        return "Imported " + job.progress.conversationsCompleted + " of up to " + job.initialConversationLimit + " conversations · " + job.progress.messagesUpserted + " messages";
      }
      return job.status === "queued" ? "Sync queued…" : "Preparing Gmail sync…";
    };
    const watchSync = async (id, progress, control, limitInput, announce = false) => {
      while (true) {
        const response = await fetch("/api/accounts/" + id + "/sync", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("Could not load sync progress.");
        const { job } = await response.json();
        if (!job) {
          progress.textContent = "Connected";
          control.disabled = false;
          limitInput.disabled = false;
          return;
        }
        progress.textContent = describeJob(job);
        if (job.status === "completed" || job.status === "failed") {
          control.disabled = false;
          limitInput.disabled = false;
          if (announce) setNotice(job.status === "failed" ? id + " sync failed: " + (job.error || "Unknown error.") : id + " sync completed.", job.status === "failed");
          return;
        }
        control.disabled = true;
        limitInput.disabled = true;
        await sleep(750);
      }
    };
    const refreshAccounts = async () => {
      const response = await fetch("/api/accounts", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Could not load account bindings.");
      const { accounts } = await response.json();
      accountsRoot.replaceChildren();
      for (const id of ["personal", "work"]) {
        const account = accounts.find((item) => item.id === id);
        const card = document.createElement("article");
        card.className = "account";
        const heading = document.createElement("h3");
        heading.textContent = slotNames[id];
        const email = document.createElement("p");
        email.className = "email";
        email.textContent = account ? account.email : "Not connected";
        const state = document.createElement("p");
        state.className = "state";
        state.textContent = account ? "Connected" : "Connect a Google account to get started.";
        const actions = document.createElement("div");
        actions.className = "actions";
        const connect = document.createElement("a");
        connect.className = "button";
        connect.href = "/auth/google/start?accountId=" + encodeURIComponent(id);
        connect.textContent = account ? "Re-connect" : "Connect Gmail";
        actions.append(connect);
        let progress;
        if (account) {
          const syncOptions = document.createElement("label");
          syncOptions.className = "sync-options";
          syncOptions.textContent = "Initial import limit (conversations)";
          const limitInput = document.createElement("input");
          limitInput.type = "number";
          limitInput.min = "1";
          limitInput.max = "10000";
          limitInput.step = "1";
          limitInput.value = localStorage.getItem("zeroeffect.initialConversationLimit." + id) || "100";
          limitInput.setAttribute("aria-label", "Initial import limit for " + slotNames[id]);
          limitInput.addEventListener("change", () => localStorage.setItem("zeroeffect.initialConversationLimit." + id, limitInput.value));
          syncOptions.append(limitInput);
          progress = document.createElement("p");
          progress.className = "state";
          progress.setAttribute("role", "status");
          progress.setAttribute("aria-live", "polite");
          progress.textContent = "Connected";
          const syncButton = button("Sync now", "secondary", async () => {
            const limit = Number(limitInput.value);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
              setNotice("Choose an initial import limit from 1 to 10000 conversations.", true);
              return;
            }
            localStorage.setItem("zeroeffect.initialConversationLimit." + id, String(limit));
            syncButton.disabled = true;
            limitInput.disabled = true;
            try {
              const syncResponse = await fetch("/api/accounts/" + id + "/sync", {
                method: "POST",
                headers: { Accept: "application/json", "Content-Type": "application/json", "X-ZeroEffect-Local": "1" },
                body: JSON.stringify({ initialConversationLimit: limit }),
              });
              const responseBody = await syncResponse.json();
              if (!syncResponse.ok && syncResponse.status !== 409) throw new Error(responseBody.error || "Could not start sync.");
              await watchSync(id, progress, syncButton, limitInput, true);
            } catch (error) {
              progress.textContent = error instanceof Error ? error.message : "Sync failed.";
              setNotice(progress.textContent, true);
              syncButton.disabled = false;
              limitInput.disabled = false;
            }
          });
          actions.append(syncButton);
          card.append(heading, email, state, syncOptions, progress, actions);
          watchSync(id, progress, syncButton, limitInput).catch((error) => {
            progress.textContent = error instanceof Error ? error.message : "Could not load sync progress.";
          });
        } else {
          card.append(heading, email, state, actions);
        }
        accountsRoot.append(card);
      }
    };
    const refreshPubSub = async () => {
      const response = await fetch("/api/pubsub", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Could not load Pub/Sub configuration.");
      const status = await response.json();
      pubsubRoot.replaceChildren();
      const heading = document.createElement("h3");
      heading.textContent = status.authorized ? "Google account authorized" : "Google account not authorized";
      const details = document.createElement("p");
      details.className = "state";
      details.textContent = status.configured
        ? "Project: " + status.projectId + " · Topic: " + status.topic + " · Subscription: " + status.subscription
        : "Set GCP_PROJECT_ID, GMAIL_PUBSUB_TOPIC, and GMAIL_PUBSUB_SUBSCRIPTION, then restart the server.";
      const note = document.createElement("p");
      note.className = "state";
      note.textContent = status.authorized
        ? (status.configured ? "Pub/Sub credential is stored encrypted on this machine." : "Authorization is saved; listener starts after project, topic, and subscription are configured.")
        : "Grant this Google account roles/pubsub.subscriber on the subscription in Cloud Console.";
      pubsubRoot.append(heading, details, note);
      if (status.authorizationAvailable) {
        const actions = document.createElement("div");
        actions.className = "actions";
        const connect = document.createElement("a");
        connect.className = "button";
        connect.href = "/auth/google/pubsub/start";
        connect.textContent = status.authorized ? "Re-authorize Pub/Sub" : "Connect Pub/Sub account";
        actions.append(connect);
        pubsubRoot.append(actions);
      }
    };
    const callback = new URLSearchParams(location.search);
    if (callback.has("connected")) setNotice("Gmail account connected. Run Sync now to verify it.");
    if (callback.has("pubsub_connected")) setNotice("Google Pub/Sub authorization saved on this machine.");
    if (callback.has("error")) setNotice(callback.get("error") || "Google authorization failed.", true);
    if (callback.has("pubsub_error")) setNotice(callback.get("pubsub_error") || "Google Pub/Sub authorization failed.", true);
    Promise.all([refreshAccounts(), refreshPubSub()]).catch((error) => setNotice(error.message, true));
  </script>
</body>
</html>`;

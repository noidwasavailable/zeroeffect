// Account setup page (served at /setup). Plain browser script: no bundling, so it runs under a strict CSP.
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

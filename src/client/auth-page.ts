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
      .environment, .intro, .email, .state, .footnote { color: #aab2c1; }
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
      <p class="intro">Bind Personal and Work separately. Each account is stored in its own database silo. After connecting, run a sync to verify Gmail access, message hydration, and Send As aliases.</p>
      <p id="notice" class="notice" role="status" aria-live="polite" hidden></p>
      <section id="accounts" class="accounts" aria-label="Gmail account bindings"></section>
      <p class="footnote">This local setup screen does not expose the full mail client or Tailscale authentication. Keep the server bound to localhost and never commit your OAuth credentials.</p>
    </main>
  </div>
  <script>
    const slotNames = { personal: "Personal", work: "Work" };
    const accountsRoot = document.getElementById("accounts");
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
        if (account) {
          actions.append(button("Sync now", "secondary", async (event) => {
            const control = event.currentTarget;
            control.disabled = true;
            setNotice("Syncing " + slotNames[id] + "…");
            try {
              const syncResponse = await fetch("/api/accounts/" + id + "/sync", { method: "POST", headers: { Accept: "application/json", "X-ZeroEffect-Local": "1" } });
              const result = await syncResponse.json();
              if (!syncResponse.ok) throw new Error(result.error || "Sync failed.");
              setNotice(slotNames[id] + " sync complete: " + result.messagesUpserted + " messages updated and " + result.messagesDeleted + " deleted. Send As aliases were synchronized.");
            } catch (error) {
              setNotice(error instanceof Error ? error.message : "Sync failed.", true);
            } finally {
              control.disabled = false;
            }
          }));
        }
        card.append(heading, email, state, actions);
        accountsRoot.append(card);
      }
    };
    const callback = new URLSearchParams(location.search);
    if (callback.has("connected")) setNotice("Gmail account connected. Run Sync now to verify it.");
    if (callback.has("error")) setNotice(callback.get("error") || "Google authorization failed.", true);
    refreshAccounts().catch((error) => setNotice(error.message, true));
  </script>
</body>
</html>`;

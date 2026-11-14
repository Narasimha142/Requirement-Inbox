// Small "Requirements" button inside Gmail that opens the dashboard and shows how many await a reply.
(() => {
  if (window.top !== window || document.getElementById("rqi-pill")) return;
  const pill = document.createElement("button");
  pill.id = "rqi-pill";
  pill.type = "button";
  pill.title = "Open Requirement Inbox";
  pill.innerHTML = '<span class="rqi-dot"></span><span class="rqi-label">Requirements</span><span class="rqi-count"></span>';
  pill.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-dashboard" }));
  document.documentElement.appendChild(pill);

  const key = r => (r.from || "") + "|" + String(r.subject || "").toLowerCase().replace(/^(re|fw|fwd):\s*/i, "").replace(/\s+/g, " ").trim();
  async function refresh() {
    try {
      const { reqs = {} } = await chrome.storage.local.get("reqs");
      const rank = { answered: 4, replied: 3, draft: 2, new: 1, skipped: 0 };
      const best = new Map();
      for (const r of Object.values(reqs)) { const k = key(r); const cur = best.get(k); if (!cur || (rank[r.status] || 0) > (rank[cur.status] || 0)) best.set(k, r); }
      const n = [...best.values()].filter(r => r.status === "new" && r.visaFit !== "no").length;
      pill.querySelector(".rqi-count").textContent = n ? n + " to answer" : "";
      pill.classList.toggle("rqi-has", n > 0);
    } catch (e) { /* extension was reloaded; ignore */ }
  }
  refresh();
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.reqs) refresh(); });
})();

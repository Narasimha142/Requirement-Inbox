import { get, groups, settings, followUpDue, fetchSummary } from "./lib/sync.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const open = hash => { chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html" + (hash ? "#" + hash : "")) }); window.close(); };

async function render() {
  const [account, reqs, sync, notes, s] = await Promise.all([get("account", null), get("reqs", {}), get("sync", null), get("notes", []), settings()]);
  if (!account) {
    $("#stats").hidden = true; $("#fetch").hidden = true;
    $("#syncline").textContent = "Open the dashboard to verify your Gmail address and start fetching.";
    return;
  }
  $("#acct").textContent = account.email;
  const gs = groups(reqs), c = { new: 0, replied: 0, draft: 0, answered: 0 };
  gs.forEach(g => { if (g.status in c) c[g.status]++; });
  const unread = notes.filter(n => !n.read && n.kind !== "new").length;
  const due = Object.values(reqs).filter(r => followUpDue(r, s)).length;
  $("#stats").innerHTML = [["Awaiting reply", c.new, ""], ["New replies", unread, "replies"], ["Follow-ups due", due, "followups"], ["Replied", c.replied + c.answered, ""]]
    .map(([l, n, h]) => `<button class="stat" data-open="${h}"><span class="n">${n}</span><span class="l">${l}</span></button>`).join("");
  const alarm = await chrome.alarms.get("fetch");
  $("#syncline").textContent = (sync?.at ? `Last fetch ${ago(sync.at)}` : "Not fetched yet") + (alarm ? ` · next ${new Date(alarm.scheduledTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "");
  $("#msg").innerHTML = sync?.error && (!sync.at || Date.parse(sync.errorAt) > Date.parse(sync.at)) ? `<div class="banner err">${esc(sync.error)}</div>` : "";
}
document.addEventListener("click", e => { const b = e.target.closest("[data-open]"); if (b) open(b.dataset.open); });
$("#open").addEventListener("click", () => open(""));
$("#fetch").addEventListener("click", async () => {
  const b = $("#fetch"); b.disabled = true; b.textContent = "Fetching…";
  const r = await chrome.runtime.sendMessage({ type: "fetch-now" }).catch(e => ({ ok: false, error: String(e) }));
  b.disabled = false; b.textContent = "Fetch now";
  $("#msg").innerHTML = r?.ok ? `<div class="banner info">${r.skipped ? "A fetch is already running." : esc(fetchSummary(r))}</div>` : `<div class="banner err">${esc(r?.error || "Fetch failed")}</div>`;
  render();
});
chrome.storage.onChanged.addListener(() => render());
render();

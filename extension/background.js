// Free built-in timer: fetches new requirement emails on a schedule while Chrome is open.
// Also receives Dice jobs from the dice.com pages you browse.
import { syncNow, updateBadge, settings, addDiceJobs, diceInfo, markApplied, get, put } from "./lib/sync.js";
import { searchUrl } from "./lib/dice.js";

async function schedule() {
  const s = await settings();
  await chrome.alarms.clear("fetch");
  await chrome.alarms.create("fetch", { periodInMinutes: Math.max(15, Number(s.intervalMin) || 60), delayInMinutes: 1 });
}
const openDashboard = (hash = "") => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html" + (hash ? "#" + hash : "")) });

// Version 1.4: LinkedIn was removed and the email search was rebuilt. Clear LinkedIn data, and make the next
// fetch look back over the full period so requirement emails the old search missed are picked up.
async function upgrade() {
  const reqs = await get("reqs", {});
  for (const k of Object.keys(reqs)) if (k.startsWith("li:") || k.startsWith("lijob:")) delete reqs[k];
  const s = await get("settings", {});
  for (const k of ["linkedinCapture", "linkedinQuery", "linkedinAuto", "linkedinEveryHours", "linkedinPosted"]) delete s[k];
  const sync = await get("sync", null);
  await put({ reqs, settings: s, ...(sync ? { sync: { ...sync, pending: Math.max(1, sync.pending || 0) } } : {}) });
  await chrome.storage.local.remove(["liStatus", "liRun"]);
  await chrome.alarms.clear("li-close");
}

chrome.runtime.onInstalled.addListener(async d => { if (d.reason === "update") await upgrade(); schedule(); updateBadge(); });
chrome.runtime.onStartup.addListener(async () => { if (!(await chrome.alarms.get("fetch"))) schedule(); updateBadge(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === "fetch") syncNow({ interactive: false, by: "timer" }).catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.settings) schedule(); });

chrome.notifications.onClicked.addListener(id => {
  const kind = id.split(":")[0];
  openDashboard(kind === "reply" || kind === "interview" ? "replies" : kind === "followup" ? "followups" : "");
  chrome.notifications.clear(id);
});

const handlers = {
  "open-dashboard": async m => { await openDashboard(m.hash || ""); return {}; },
  "fetch-now": async () => ({ ok: true, ...(await syncNow({ interactive: false, by: "manual" })) }),
  "open-dice-search": async () => { await chrome.tabs.create({ url: searchUrl(await settings()) }); return {}; },
  // a Dice job page you opened
  "dice-job": async m => { await addDiceJobs([{ id: m.id, html: m.html, title: m.title, text: m.text }], { max: 1 }); return diceInfo(m.id); },
  // job links seen on a Dice search page
  "dice-ids": async m => ({ ok: true, ...(await addDiceJobs(m.items || [], { max: 20 })) }),
  "dice-applied": async m => { await markApplied("dice:" + m.id, m.applied !== false); return diceInfo(m.id); },
  "dice-info": async m => diceInfo(m.id)
};
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg, sender).then(reply, e => reply({ ok: false, error: e.message || String(e) }));
  return true;
});

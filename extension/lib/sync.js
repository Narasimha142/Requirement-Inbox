// Fetching, filtering, reply tracking, alerts and sending. Shared by the background timer, the popup and the dashboard.
import * as G from "./gmail.js";
import { junkReason, extract, emailOf, domainOf, rateHourly, isInterviewInvite, parseWhen, profileReason, roleSimilarity, DEFAULT_ROLE_KEYWORDS, OLD_ROLE_KEYWORDS } from "./extract.js";
import * as Dice from "./dice.js";
import * as Boards from "./boards.js";
import * as HN from "./hn.js";
import { extractWithGemini, mergeAi } from "./ai.js";

const DAY = 864e5;
export const DEFAULT_TEMPLATES = [
  { id: "default", name: "Ask about visa + experience", attach: "none", body: "Hi {first_name},\n\nThank you for sharing the {role} requirement. Before I send my resume, could you please confirm whether {my_visa} work authorization and {my_years} years of experience would be acceptable for this role?\n\nBest regards,\n{my_name}\n{my_phone}" },
  { id: "followup", name: "Follow-up", attach: "none", body: "Hi {first_name},\n\nJust following up on my earlier note about the {role} role. Could you let me know whether {my_visa} and {my_years} years of experience work for this position? I'm happy to share my resume right away.\n\nBest regards,\n{my_name}\n{my_phone}" },
  { id: "posting", name: "Apply to a posting (job boards)", attach: "best", body: "Hello {first_name},\n\nI saw the {role} opening at {company} and would like to be considered. I have {my_years} years of experience and I'm on {my_visa}. My resume is attached.\n\nPhone: {my_phone}\nLinkedIn: {my_linkedin}\n\nThank you,\n{my_name}" },
  { id: "resume", name: "Share resume", attach: "best", body: "Hi {first_name},\n\nThank you for getting back to me. Please find my resume attached for the {role} role.\n\nName: {my_name}\nPhone: {my_phone}\nEmail: {my_email}\nCurrent location: {my_location}\nVisa: {my_visa}{my_visa_until}\nExperience: {my_years} years\nCurrent company: {my_company}\nAvailability: {my_availability}\nLinkedIn: {my_linkedin}\n\nLet me know if you need anything else from me.\n\nBest regards,\n{my_name}" }
];
export const DEFAULT_TEMPLATE = DEFAULT_TEMPLATES[0];
export const DEFAULT_SETTINGS = {
  intervalMin: 60, perFetch: 30, lookbackDays: 30,
  myName: "", myYears: 5, myLocations: "", rateFloor: 0,
  // Filled in on the Profile tab after you connect Gmail.
  profile: { done: false, phone: "", linkedin: "", location: "", relocate: "", company: "", title: "", availability: "", empTypes: [], workModes: [], rate: "", salary: "", visa: "", visaUntil: "", jobTitles: "", skills: "" },
  excludeClearance: true, excludeCitizenOnly: true,
  notifyNew: true, notifyReplies: true, notifyFollowUps: true, emailAlerts: false,
  followUpDays: 3, maxFollowUps: 2,
  profileOnly: true, roleKeywords: DEFAULT_ROLE_KEYWORDS, maxYears: 5, yearsSlack: 1, skipSeniorTitles: true,
  diceAlerts: true, diceQuery: "Software Engineer", diceLocation: "Dallas, TX", dicePosted: 3, diceRemote: false,
  // Jobs from job boards: Dice searches for your job titles, and Indeed / ZipRecruiter / Glassdoor / Monster alert emails.
  boardsOn: true, boardHours: 24, diceSearchOn: true, diceSearchEveryHours: 3, startupsOn: true,
  geminiKey: "", geminiModel: "gemini-3.5-flash-lite"
};
export const VISA_TYPES = ["STEM OPT", "OPT", "H-1B", "H-4 EAD", "L-2 EAD", "GC EAD", "Green Card", "US Citizen", "TN", "E-3", "CPT", "Other"];
const AUTHORIZED = ["Green Card", "US Citizen"]; // never filtered for "USC / GC only"
export async function settings() {
  const saved = await get("settings", {});
  const s = { ...DEFAULT_SETTINGS, ...saved, profile: { ...DEFAULT_SETTINGS.profile, ...(saved.profile || {}) } };
  if (s.geminiModel === "gemini-2.5-flash") s.geminiModel = "gemini-3.5-flash-lite"; // 2.5 isn't offered to new Google projects
  if (s.roleKeywords === OLD_ROLE_KEYWORDS) s.roleKeywords = DEFAULT_ROLE_KEYWORDS; // untouched old default → newer, wider list
  return s;
}
// One readable line for the result of a fetch.
export function fetchSummary(r) {
  if (!r) return "";
  const parts = [];
  if (r.added) parts.push(`${r.added} new requirement${r.added === 1 ? "" : "s"}`);
  else parts.push(`No new requirement emails since the last fetch. Checked ${r.scanned || 0} from the last ${r.days || 1} day${r.days === 1 ? "" : "s"}${r.known ? `, ${r.known} already in your dashboard` : ""}`);
  if (r.restored) parts.push(r.restored === 1 ? "1 earlier filtered role now matches your titles and is back" : `${r.restored} earlier filtered roles now match your titles and are back`);
  if (r.filtered) parts.push(`${r.filtered} filtered out (${r.filterReasons || "see Filtered out"})`);
  if (r.replies) parts.push(`${r.replies} recruiter repl${r.replies === 1 ? "y" : "ies"}`);
  if (r.dice) parts.push(`${r.dice} from Dice`);
  if (r.pending) parts.push(`${r.pending} older emails next time`);
  return parts.join(" · ");
}

// ---------- storage ----------
export async function get(key, fallback) { const o = await chrome.storage.local.get(key); return o[key] ?? fallback; }
export async function put(obj) { await chrome.storage.local.set(obj); }
export async function patchReq(id, patch) { const reqs = await get("reqs", {}); if (!reqs[id]) return; reqs[id] = { ...reqs[id], ...patch }; await put({ reqs }); }
export async function logActivity(a) {
  const list = await get("activity", []);
  list.unshift({ at: new Date().toISOString(), ...a });
  await put({ activity: list.slice(0, 1000) });
}
export async function addNote(n) {
  const notes = await get("notes", []);
  if (n.key && notes.some(x => x.key === n.key)) return false;
  notes.unshift({ id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), read: false, ...n });
  await put({ notes: notes.slice(0, 300) });
  return true;
}
async function push(id, title, message) {
  try { await chrome.notifications.create(id + ":" + Date.now(), { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message, priority: 1 }); } catch (e) { /* notifications off */ }
}

// ---------- grouping ----------
export const groupKey = r => r.source === "dice" || r.source === "board" ? r.id : (r.from || "") + "|" + String(r.subject || "").toLowerCase().replace(/^(re|fw|fwd):\s*/i, "").replace(/\s+/g, " ").trim();
const RANK = { answered: 5, replied: 4, applied: 4, draft: 3, new: 2, skipped: 1, filtered: 0 };
export function groups(reqsMap) {
  const map = new Map();
  for (const r of Object.values(reqsMap || {})) {
    const k = groupKey(r), g = map.get(k);
    if (!g) map.set(k, { lead: r, all: [r] });
    else { g.all.push(r); if (Date.parse(r.received) > Date.parse(g.lead.received)) g.lead = r; }
  }
  return [...map.values()].map(g => {
    const best = g.all.reduce((a, b) => (RANK[b.status] ?? 0) > (RANK[a.status] ?? 0) ? b : a, g.lead);
    return { ...g, status: best.status, ref: best.status === "new" ? g.lead : best };
  }).sort((a, b) => Date.parse(b.lead.received) - Date.parse(a.lead.received));
}
export async function updateBadge() {
  const reqs = await get("reqs", {});
  const notes = await get("notes", []);
  const n = groups(reqs).filter(g => g.status === "new").length;
  const unread = notes.filter(x => !x.read && x.kind !== "new").length;
  await chrome.action.setBadgeBackgroundColor({ color: unread ? "#17734a" : "#1f4fd1" });
  await chrome.action.setBadgeText({ text: unread ? "↩" + unread : n ? String(n > 99 ? "99+" : n) : "" });
}

// ---------- templates ----------
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "";
export function fill(body, r, s = DEFAULT_SETTINGS) {
  const first = r.recruiterName ? cap(r.recruiterName.split(/\s+/)[0]) : "";
  return body.replace(/ ?\{first_name\}/g, first ? " " + first : "")
    .replace(/\{role\}/g, r.role || "this").replace(/\{location\}/g, r.location || "")
    .replace(/\{company\}/g, r.client || r.vendor || "").replace(/\{vendor\}/g, r.vendor || "")
    .replace(/\{my_name\}/g, s.myName || "").replace(/\{my_years\}/g, String(s.myYears ?? ""))
    .replace(/\{my_(\w+)\}/g, (m, k) => myField(k, s));
}
// Subject of your first email about a job-board or Dice posting.
export const postingSubject = r => `${r.role || "Your opening"}${r.vendor && r.vendor !== r.site ? " at " + r.vendor : ""}${r.location ? " - " + r.location : ""}`;
// Your profile details for templates: {my_phone}, {my_visa}, {my_company} …  Empty fields leave nothing behind.
function myField(k, s) {
  const p = s.profile || {};
  const v = {
    email: s.account?.email || p.email || "", phone: p.phone, linkedin: p.linkedin, location: p.location,
    company: p.company, title: p.title, availability: p.availability, rate: p.rate, salary: p.salary,
    visa: p.visa || "my", visa_until: p.visaUntil ? ` (valid until ${new Date(p.visaUntil + "T12:00").toLocaleDateString("en-US", { month: "short", year: "numeric" })})` : "",
    skills: p.skills, relocate: p.relocate, work_mode: (p.workModes || []).join(" / "), employment: (p.empTypes || []).join(" / ")
  }[k];
  return v === undefined ? `{my_${k}}` : String(v || "");
}
// Template lines like "Phone: {my_phone}" disappear when that detail isn't in your profile.
export function fillClean(body, r, s) {
  return String(body).split("\n").filter(line => {
    if (!/\{my_\w+\}/.test(line)) return true;
    return !/^[A-Za-z ]{2,24}:\s*$/.test(fill(line, r, s)); // "Phone:" with nothing after it
  }).map(line => fill(line, r, s)).join("\n");
}

// ---------- filters ----------
export function autoFilter(r, s, muted) {
  if (muted?.[domainOf(r.from || "")]) return "Muted vendor";
  if (s.excludeClearance && r.clearance) return "Security clearance";
  if (s.excludeCitizenOnly && r.visaFit === "no" && !AUTHORIZED.includes(s.profile?.visa)) return "USC / GC only";
  return profileReason(r, s);
}
export const followUpDue = (r, s) => r.status === "replied" && !r.recruiterRepliedAt && (r.followUpCount || 0) < (Number(s.maxFollowUps) || 2)
  && Date.now() - Date.parse(r.lastSentAt || r.repliedAt) > (Number(s.followUpDays) || 3) * DAY;

// ---------- fetching ----------
const EXCLUDE = ["linkedin.com","ziprecruiter.com","glassdoor.com","indeed.com","monster.com","dice.com","efinancialcareers.com","wellfound.com","remotehunter.com","hireft.com","jobs2web.com","o2ten.com","substack.com","udemy.com","builtin.com","naukri.com","roberthalf.com","randstadusa.com","experis.com","mailsuite.com"];
// A deliberately simple Gmail search: everything recent that isn't yours or from a job board. Long Gmail searches with
// many OR terms silently drop matching emails, so deciding what is a requirement happens here, in junkReason().
function reqQuery(days) {
  return `newer_than:${days}d -in:sent -in:drafts -in:chats -category:social -{${EXCLUDE.map(d => "from:" + d).join(" ")}}`;
}
const isMine = (m, me) => (m.labelIds || []).includes("SENT") || emailOf(G.header(m, "From")) === me;
const iso = m => new Date(Number(m.internalDate)).toISOString();
const gmailUrl = (id, me) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(me)}#all/${id}`;

async function pool(items, n, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function takeLock() {
  const lock = await get("lock", null);
  if (lock && Date.now() - Date.parse(lock.at) < 5 * 60e3) return false;
  await put({ lock: { at: new Date().toISOString() } });
  return true;
}
const releaseLock = () => chrome.storage.local.remove("lock");
const mergeSave = async (reqs, ignored) => put({ reqs: { ...(await get("reqs", {})), ...reqs }, ...(ignored ? { ignored } : {}) });

export async function syncNow({ interactive = false, by = "timer", onProgress = () => {} } = {}) {
  const account = await get("account", null);
  if (!account) return { skipped: "not verified" };
  if (!(await takeLock())) return { skipped: "already fetching" };
  const me = account.email;
  let reqs = {}, ignored = {}, diceAfter = null;
  const summary = { added: 0, filtered: 0, replies: [], interviews: [], followUps: 0, aiError: "", dice: { added: 0, filtered: 0 } };
  try {
    const s = await settings();
    const muted = await get("muted", {});
    reqs = await get("reqs", {});
    ignored = await get("ignored", {});
    // bring back roles that only failed the title check, if the title list now covers them
    for (const r of Object.values(reqs)) if (r.status === "filtered" && r.filterReason === "Not your role" && !autoFilter(r, s, muted)) { r.status = "new"; r.filterReason = ""; summary.restored = (summary.restored || 0) + 1; }
    const last = await get("sync", null);
    const perFetch = Math.max(5, Number(s.perFetch) || 30);
    const lookback = Math.max(1, Number(s.lookbackDays) || 30);
    const caughtUp = last?.at && !last.error && !last.pending && Date.now() - Date.parse(last.at) < 3 * DAY;
    const days = caughtUp ? Math.min(4, lookback) : lookback;
    if (s.diceAlerts || s.boardsOn || s.diceSearchOn || s.startupsOn) diceAfter = { days, s };
    if (interactive) await G.getToken(true);

    onProgress({ label: "Looking for requirement emails…" });
    const ids = []; let page = "", pages = 0;
    do {
      const res = await G.listThreads(reqQuery(days), page, 100);
      (res.threads || []).forEach(t => ids.push(t.id));
      page = res.nextPageToken || ""; pages++;
    } while (page && pages < 6);

    // Each new email's subject and sender are checked once (cheap); only requirements are read in full,
    // up to "perFetch" of them per fetch. Anything not reached this time is picked up on the next fetch.
    const waiting = ids.filter(id => !reqs[id] && !ignored[id]); // newest first
    const MAX_CHECKS = 200;
    const unseen = waiting.slice(0, MAX_CHECKS);
    const fresh = [], deferred = new Set();
    let done = 0, fullReads = 0;
    onProgress({ label: "Checking new emails…", done, total: unseen.length });
    await pool(unseen, 2, async id => {
      try {
        if (fullReads >= perFetch) { deferred.add(id); return; }
        const t = await G.getThreadMeta(id);
        const msgs = t.messages || [];
        const theirs = msgs.filter(m => !isMine(m, me));
        const first = theirs[0];
        if (!first) { ignored[id] = Date.now(); return; }
        const subject = G.header(first, "Subject"), from = emailOf(G.header(first, "From"));
        if (junkReason(subject, from, first.snippet || "")) { ignored[id] = Date.now(); return; }
        if (fullReads >= perFetch) { deferred.add(id); return; }
        fullReads++;
        const full = await G.getMessage(first.id);
        const body = G.bodyText(full).slice(0, 9000);
        const latest = theirs[theirs.length - 1];
        const r = {
          id, subject, from, received: iso(first), url: gmailUrl(id, me), snippet: first.snippet || "",
          firstId: first.id, messageId: latest.id, rfcId: G.header(latest, "Message-ID"), refs: G.header(latest, "References"),
          ...extract(subject, from, body), extractedBy: "rules", body: body.slice(0, 8000), status: "new", fetchedAt: new Date().toISOString()
        };
        const why = autoFilter(r, s, muted);
        if (why) { r.status = "filtered"; r.filterReason = why; }
        reqs[id] = r; fresh.push(id);
      } finally {
        done++; onProgress({ label: "Checking new emails…", done, total: unseen.length });
        if (done % 10 === 0) await mergeSave(reqs, ignored);
      }
    });
    const pending = (waiting.length - unseen.length) + deferred.size;
    for (const [k, v] of Object.entries(ignored)) if (Date.now() - v > 35 * DAY) delete ignored[k];
    await mergeSave(reqs, ignored);

    // optional AI clean-up of the new ones
    if (s.geminiKey && fresh.length) {
      onProgress({ label: "Cleaning up details with Gemini…", done: 0, total: fresh.length });
      for (let k = 0; k < fresh.length; k += 5) {
        const batch = fresh.slice(k, k + 5).map(id => reqs[id]);
        try {
          const ai = await extractWithGemini(batch, { key: s.geminiKey, model: s.geminiModel, years: s.myYears, visa: s.profile?.visa });
          for (const r of batch) {
            const m = mergeAi(r, ai[r.id]);
            m.rateHourly = rateHourly(m.rate);
            const why = autoFilter(m, s, muted);
            reqs[r.id] = { ...m, status: why ? "filtered" : "new", filterReason: why || "" };
          }
        } catch (e) { summary.aiError = e.message; break; }
        onProgress({ label: "Cleaning up details with Gemini…", done: Math.min(fresh.length, k + 5), total: fresh.length });
        await sleep(4500); // stay inside the free tier's per-minute limit
      }
      await mergeSave(reqs);
    }
    summary.added = fresh.filter(id => reqs[id].status === "new").length;
    summary.filtered = fresh.length - summary.added;
    const reasons = {}; fresh.forEach(id => { const w = reqs[id].filterReason; if (reqs[id].status === "filtered" && w) reasons[w] = (reasons[w] || 0) + 1; });
    summary.filterReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w.toLowerCase()}`).join(", ");
    summary.known = ids.filter(id => reqs[id]).length - fresh.length;
    summary.newOk = fresh.filter(id => reqs[id].status === "new" && reqs[id].visaFit === "ok").length;

    onProgress({ label: "Checking replies and interviews…" });
    const ivBefore = new Set(Object.keys(await get("interviews", {})));
    summary.replies = await refreshReplyState(me);
    await scanInterviews(me);
    summary.interviews = Object.values(await get("interviews", {})).filter(iv => !ivBefore.has(iv.id));
    summary.followUps = await checkFollowUps(s);

    await put({ sync: { at: new Date().toISOString(), by, lastNew: summary.added, filtered: summary.filtered, read: fullReads, scanned: ids.length, pending, aiError: summary.aiError } });
    await alert(summary, s, me);
    await updateBadge();
    return { added: summary.added, filtered: summary.filtered, filterReasons: summary.filterReasons, restored: summary.restored || 0, known: summary.known, scanned: ids.length, days, read: fullReads, pending, replies: summary.replies.length, interviews: summary.interviews.length, dice: summary.dice.added };
  } catch (e) {
    if (Object.keys(reqs).length || Object.keys(ignored).length) await mergeSave(reqs, ignored);
    await updateBadge();
    await put({ sync: { ...(await get("sync", {})), error: e.message || String(e), errorCode: e.code || "", errorAt: new Date().toISOString() } });
    throw e;
  } finally {
    await releaseLock();
    // Dice job pages load slowly (one every second), so they're read after the email fetch has finished,
    // without holding it up. New matches arrive as their own desktop alert.
    if (diceAfter) diceInBackground(me, diceAfter.days, diceAfter.s);
  }
}
let diceRunning = false;
async function diceInBackground(me, days, s) {
  if (diceRunning) return; diceRunning = true;
  try {
    let added = 0;
    if (s.diceAlerts) added += (await scanDiceAlerts(me, days, () => {}).catch(() => null))?.added || 0;
    if (s.diceAlerts) await scanDiceApplications(s).catch(() => null);
    if (s.boardsOn) added += (await scanBoardAlerts(s).catch(() => null))?.added || 0;
    if (s.startupsOn) { const h = await scanStartups(s).catch(e => ({ error: e.message })); if (h) { added += h.added || 0; await put({ boardsLast: { ...(await get("boardsLast", {})), hn: h } }); } }
    if (s.diceSearchOn) { const d = await searchDiceTitles(s).catch(() => null); if (d) { added += d.added || 0; await put({ boardsLast: { ...(await get("boardsLast", {})), dice: d } }); } }
    await put({ boardsAt: new Date().toISOString() });
    if (added) { if (s.notifyNew) await push("dice", "New jobs for you", `${added} job-board posting${added === 1 ? "" : "s"} match your profile`); await updateBadge(); }
  } catch (e) { /* Dice is optional; it tries again on the next fetch */ }
  finally { diceRunning = false; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Who replied: compares your sent messages with later recruiter messages in each thread.
export async function refreshReplyState(me) {
  const reqs = await get("reqs", {});
  const sentIds = new Set(), hist = {}; let page = "", pages = 0;
  do {
    const res = await G.listThreads("in:sent newer_than:45d", page, 100);
    (res.threads || []).forEach(t => { sentIds.add(t.id); hist[t.id] = t.historyId || ""; });
    page = res.nextPageToken || ""; pages++;
  } while (page && pages < 3);

  const drafts = new Map();
  try {
    let dp = "", n = 0;
    do { const d = await G.listDrafts(dp); (d.drafts || []).forEach(x => x.message?.threadId && drafts.set(x.message.threadId, x.id)); dp = d.nextPageToken || ""; n++; } while (dp && n < 2);
  } catch (e) { /* drafts are optional */ }

  const tidOf = r => r.threadId || (r.source === "dice" || r.source === "board" ? "" : r.id); // the Gmail thread a requirement lives in
  // Gmail gives every thread a "history id" that changes whenever anything happens in it. A thread already checked
  // whose history id hasn't changed has no new reply, so it isn't opened again. This keeps fetches quick.
  const seenHist = await get("threadHist", {});
  const ids = Object.keys(reqs).filter(id => {
    const r = reqs[id], tid = tidOf(r);
    if (!sentIds.has(tid) || ["answered", "skipped", "filtered"].includes(r.status)) return false;
    return !(hist[tid] && seenHist[tid] === hist[tid] && r.repliedAt);
  });
  const info = {};
  await pool(ids, 2, async id => {
    const t = await G.getThreadMeta(tidOf(reqs[id]));
    const msgs = t.messages || [];
    const mine = msgs.filter(m => isMine(m, me));
    if (!mine.length) return;
    const firstMine = Number(mine[0].internalDate);
    const after = msgs.filter(m => !isMine(m, me) && Number(m.internalDate) > firstMine);
    const latestTheirs = [...msgs].reverse().find(m => !isMine(m, me));
    const reply = after[after.length - 1];
    info[id] = {
      repliedAt: iso(mine[0]), lastSentAt: iso(mine[mine.length - 1]),
      recruiterRepliedAt: reply ? iso(reply) : null,
      recruiterReplySnippet: reply ? (reply.snippet || "") : "",
      recruiterReplySubject: reply ? G.header(reply, "Subject") : "",
      ...(latestTheirs ? { messageId: latestTheirs.id, rfcId: G.header(latestTheirs, "Message-ID"), refs: G.header(latestTheirs, "References") } : {})
    };
  });

  const fresh = await get("reqs", {});
  const newReplies = [];
  for (const r of Object.values(fresh)) {
    if (r.status === "skipped" || r.status === "filtered") continue;
    const s = info[r.id];
    if (s) {
      const wasNew = s.recruiterRepliedAt && !r.recruiterRepliedAt;
      Object.assign(r, s, { status: s.recruiterRepliedAt ? "answered" : "replied" });
      if (wasNew) newReplies.push(r);
      continue;
    }
    const d = tidOf(r) ? drafts.get(tidOf(r)) : null;
    if (d && r.status !== "answered") Object.assign(r, { status: r.status === "replied" ? "replied" : "draft", draftId: d, draftAt: r.draftAt || new Date().toISOString() });
    else if (r.status === "draft" && !d) Object.assign(r, { status: "new", draftId: null });
  }
  const keepHist = {};
  for (const tid of sentIds) if (hist[tid] && (seenHist[tid] || ids.some(id => tidOf(fresh[id] || {}) === tid))) keepHist[tid] = hist[tid];
  await put({ reqs: fresh, threadHist: keepHist });
  for (const r of newReplies) {
    await addNote({ key: "reply:" + r.id + ":" + r.recruiterRepliedAt, kind: "reply", reqId: r.id, title: `${r.recruiterName || r.vendor || r.from} replied: ${r.role}`, body: r.recruiterReplySnippet || "" });
    if (isInterviewInvite(r.recruiterReplySubject || "", r.recruiterReplySnippet || "", r.from)) await addInterview({ reqId: r.id, threadId: tidOf(r) || r.id, subject: r.recruiterReplySubject || r.subject, from: r.from, snippet: r.recruiterReplySnippet, at: r.recruiterRepliedAt, url: r.url });
  }
  return newReplies;
}

async function addInterview(iv) {
  const list = await get("interviews", {});
  if (list[iv.threadId]) return null;
  const when = parseWhen(`${iv.subject}\n${iv.snippet}`, new Date(iv.at || Date.now()));
  list[iv.threadId] = { id: iv.threadId, ...iv, when, inCalendar: /calendar-notification@google\.com/i.test(iv.from || ""), detectedAt: new Date().toISOString() };
  await put({ interviews: list });
  await addNote({ key: "interview:" + iv.threadId, kind: "interview", reqId: iv.reqId || "", title: "Interview: " + (iv.subject || "").replace(/^(re|fw|fwd|invitation):\s*/i, ""), body: iv.snippet || "" });
  return list[iv.threadId];
}

// Interview invites: a small search each fetch; each thread is only examined once.
export async function scanInterviews(me) {
  const seen = await get("interviewSeen", {});
  const reqs = await get("reqs", {});
  const res = await G.listThreads(`newer_than:7d -in:sent (subject:interview OR subject:invitation OR "interview scheduled" OR "interview invitation" OR "schedule an interview" OR "availability for an interview")`, "", 20);
  const ids = (res.threads || []).map(t => t.id).filter(id => !seen[id]);
  const found = [];
  await pool(ids, 2, async id => {
    seen[id] = Date.now();
    const t = await G.getThreadMeta(id);
    const msgs = (t.messages || []).filter(m => !isMine(m, me));
    const m = msgs[msgs.length - 1]; if (!m) return;
    const subject = G.header(m, "Subject"), from = emailOf(G.header(m, "From"));
    if (!isInterviewInvite(subject, m.snippet || "", from)) return;
    const req = reqs[id] || Object.values(reqs).find(r => r.threadId === id) || Object.values(reqs).find(r => r.from === from);
    const iv = await addInterview({ reqId: req?.id || "", threadId: id, subject, from, snippet: m.snippet || "", at: iso(m), url: gmailUrl(id, me) });
    if (iv) found.push(iv);
  });
  for (const [k, v] of Object.entries(seen)) if (Date.now() - v > 20 * DAY) delete seen[k];
  await put({ interviewSeen: seen });
  return found;
}

async function checkFollowUps(s) {
  const reqs = await get("reqs", {});
  const due = Object.values(reqs).filter(r => followUpDue(r, s) && !(r.followUpNotifiedAt && Date.parse(r.followUpNotifiedAt) > Date.parse(r.lastSentAt || r.repliedAt)));
  if (!due.length) return 0;
  const now = new Date().toISOString();
  due.forEach(r => { reqs[r.id].followUpNotifiedAt = now; });
  await put({ reqs });
  await addNote({ key: "followup:" + now.slice(0, 13), kind: "followup", title: `${due.length} follow-up${due.length === 1 ? "" : "s"} due`, body: due.slice(0, 4).map(r => `${r.vendor || r.from}: ${r.role}`).join(" · ") });
  return due.length;
}

async function alert(sum, s, me) {
  const lines = [];
  if (sum.added) lines.push(`${sum.added} new requirement${sum.added === 1 ? "" : "s"}${sum.newOk ? ` (${sum.newOk} accept OPT)` : ""}${sum.filtered ? `, ${sum.filtered} filtered out` : ""}`);
  sum.replies.forEach(r => lines.push(`${r.recruiterName || r.vendor || r.from} replied about ${r.role}: ${(r.recruiterReplySnippet || "").slice(0, 120)}`));
  sum.interviews.forEach(iv => lines.push(`Interview: ${iv.subject}`));
  if (sum.followUps) lines.push(`${sum.followUps} follow-up${sum.followUps === 1 ? "" : "s"} due`);
  if (sum.dice?.added) lines.push(`${sum.dice.added} new Dice job${sum.dice.added === 1 ? "" : "s"} match your profile`);
  if (s.notifyNew && sum.added) await push("new", `${sum.added} new requirement${sum.added === 1 ? "" : "s"}`, lines[0]);
  if (s.notifyNew && sum.dice?.added) await push("dice", "New Dice jobs for you", `${sum.dice.added} match your profile`);
  if (s.notifyReplies) {
    for (const r of sum.replies.slice(0, 3)) await push("reply", `${r.recruiterName || r.vendor || "Recruiter"} replied`, `${r.role}: ${(r.recruiterReplySnippet || "").slice(0, 140)}`);
    for (const iv of sum.interviews.slice(0, 2)) await push("interview", "Interview invite", iv.subject || "");
  }
  if (s.notifyFollowUps && sum.followUps) await push("followup", "Follow-ups due", `${sum.followUps} recruiter${sum.followUps === 1 ? " hasn't" : "s haven't"} replied in ${s.followUpDays} days`);
  if (s.emailAlerts && lines.length && (sum.replies.length || sum.interviews.length || sum.added || sum.dice?.added)) {
    try { await G.sendToSelf({ to: me, subject: `Requirement Inbox: ${lines[0]}`, body: lines.join("\n") + "\n\nOpen the Requirement Inbox dashboard to reply." }); } catch (e) { /* alert email is best-effort */ }
  }
}

// ---------- replying ----------
// groupsToSend: [{ lead: req, all: [req...] }]; mode: "send" | "draft" | "followup"
// attachFor(r): optional; returns the resume to attach for that requirement ({ filename, mimeType, data }) or null.
export async function sendBulk({ groupsToSend, body, tplName, mode, attachFor = null, onProgress = () => {} }) {
  const s = await settings(); s.account = await get("account", null);
  let done = 0, failed = 0; const errors = [];
  for (const g of groupsToSend) {
    const r = g.lead, text = fillClean(body, r, s);
    const attachment = attachFor ? await attachFor(r) : null;
    const posting = r.source !== "email";
    const args = posting ? { threadId: r.threadId || undefined, to: r.from, subject: (r.threadId ? "Re: " : "") + postingSubject(r), body: text, attachments: attachment ? [attachment] : [] }
      : { threadId: r.id, to: r.from, subject: r.subject, body: text, inReplyTo: r.rfcId, references: r.refs, attachments: attachment ? [attachment] : [] };
    try {
      const now = new Date().toISOString();
      if (mode === "draft") {
        const res = posting ? await G.createDraftNew(args) : await G.createDraftReply(args);
        await patchReq(r.id, { status: "draft", draftId: res?.id || "", draftAt: now, replyTemplate: tplName, ...(posting && res?.message?.threadId ? { threadId: res.message.threadId } : {}) });
      } else {
        const res = posting ? await G.sendNew(args) : await G.sendReply(args);
        const reqs = await get("reqs", {});
        for (const x of g.all) {
          if (!reqs[x.id]) continue;
          if (mode === "followup") Object.assign(reqs[x.id], { lastSentAt: now, lastFollowUpAt: now, followUpCount: (reqs[x.id].followUpCount || 0) + 1 });
          else Object.assign(reqs[x.id], { status: "replied", repliedAt: now, lastSentAt: now, replyTemplate: tplName, ...(x.id === r.id ? { sentMessageId: res?.id || "", ...(posting && res?.threadId ? { threadId: res.threadId } : {}) } : {}) });
        }
        await put({ reqs });
      }
      await logActivity({ kind: mode === "send" ? "sent" : mode, reqId: r.id, role: r.role, to: r.from, vendor: r.vendor, template: tplName + (attachment ? ` + ${attachment.filename}` : ""), ok: true });
    } catch (e) {
      failed++;
      const unsure = mode !== "draft" && !/^http_4/.test(e.code || "") && !["auth", "setup", "rate"].includes(e.code);
      errors.push(`${r.role}: ${unsure ? "no confirmation from Gmail, check Sent before retrying" : e.message}`);
      await logActivity({ kind: mode === "send" ? "sent" : mode, reqId: r.id, role: r.role, to: r.from, vendor: r.vendor, template: tplName, ok: false, error: unsure ? "Unconfirmed" : e.message });
      if (["auth", "setup"].includes(e.code)) { errors.unshift(e.message); break; }
    }
    done++; onProgress({ done, failed, total: groupsToSend.length });
    await sleep(400);
  }
  await updateBadge();
  return { done, failed, errors };
}

// A reply draft in Gmail (optionally with the resume attached) for you to review and send.
export async function draftReply({ req, body, tplName, attachment }) {
  const s = await settings();
  const attachments = attachment ? [attachment] : [];
  const posting = req.source !== "email";
  if (posting && !req.from) throw new Error("This posting has no recruiter email. Apply on the site instead.");
  const res = posting ? await G.createDraftNew({ threadId: req.threadId || undefined, to: req.from, subject: (req.threadId ? "Re: " : "") + postingSubject(req), body: fill(body, req, s), attachments })
    : await G.createDraftReply({ threadId: req.id, to: req.from, subject: req.subject, body: fill(body, req, s), inReplyTo: req.rfcId, references: req.refs, attachments });
  await patchReq(req.id, { nextDraftId: res?.id || "", nextDraftAt: new Date().toISOString(), ...(posting && !req.threadId && res?.message?.threadId ? { threadId: res.message.threadId } : {}) });
  await logActivity({ kind: "draft", reqId: req.id, role: req.role, to: req.from, vendor: req.vendor, template: tplName + (attachment ? " + resume" : ""), ok: true });
  return res;
}

export async function sendExistingDraft(id) {
  const reqs = await get("reqs", {}); const r = reqs[id];
  if (!r?.draftId) throw new Error("No draft found for this requirement.");
  await G.sendDraft(r.draftId);
  const now = new Date().toISOString();
  Object.assign(r, { status: "replied", repliedAt: now, lastSentAt: now, draftId: null });
  await put({ reqs });
  await logActivity({ kind: "draft-sent", reqId: id, role: r.role, to: r.from, vendor: r.vendor, template: r.replyTemplate || "", ok: true });
  await updateBadge();
}

// ---------- Dice ----------
// Adds Dice jobs (ids from alert emails or pages you browsed). Each job page is read once.
// items: [{ id, title?, company?, location?, html?, text? }]
// maxAgeHours: skip jobs posted longer ago than this (when the page says when it was posted).
export async function addDiceJobs(items, { onProgress = () => {}, max = 25, maxAgeHours = 0 } = {}) {
  const s = await settings();
  const muted = await get("muted", {});
  const reqs = await get("reqs", {});
  const seen = await get("diceSeen", {});
  const todo = items.filter(x => x?.id && !reqs["dice:" + x.id] && (x.html || !seen[x.id])).slice(0, max);
  let added = 0, filtered = 0, done = 0;
  for (const it of todo) {
    try {
      const job = it.html ? Dice.parseJobPage(it.html, it.id, it) : await Dice.fetchJob(it.id, it);
      const tooOld = maxAgeHours && job?.posted && Date.now() - Date.parse(job.posted) > maxAgeHours * 36e5;
      if (job && job.title && !tooOld) {
        const r = Dice.toRequirement(job);
        const why = autoFilter(r, s, muted);
        if (why) { r.status = "filtered"; r.filterReason = why; filtered++; } else added++;
        reqs[r.id] = r;
      }
      seen[it.id] = Date.now();
    } catch (e) { /* page not readable right now; try again another time */ }
    done++; onProgress({ label: "Reading Dice jobs…", done, total: todo.length });
    if (!it.html && done < todo.length) await sleep(1000);
  }
  for (const [k, v] of Object.entries(seen)) if (Date.now() - v > 45 * DAY) delete seen[k];
  await put({ reqs: { ...(await get("reqs", {})), ...Object.fromEntries(Object.entries(reqs).filter(([k]) => k.startsWith("dice:"))) }, diceSeen: seen });
  await updateBadge();
  return { added, filtered, checked: todo.length };
}

// Dice job-alert emails in Gmail: every job linked in them becomes a row.
export async function scanDiceAlerts(me, days, onProgress) {
  const seen = await get("diceMailSeen", {});
  const res = await G.listThreads(`from:dice.com newer_than:${Math.max(2, days)}d -subject:(password OR verify OR verification OR account OR receipt)`, "", 20);
  const ids = (res.threads || []).map(t => t.id).filter(id => !seen[id]);
  const items = [];
  for (const id of ids) {
    const t = await G.getThreadMeta(id);
    for (const m of t.messages || []) {
      const full = await G.getMessage(m.id);
      Dice.idsFromHtml(G.bodyHtml(full) || G.bodyText(full)).forEach(x => items.push(x));
    }
    seen[id] = Date.now();
  }
  for (const [k, v] of Object.entries(seen)) if (Date.now() - v > 45 * DAY) delete seen[k];
  await put({ diceMailSeen: seen });
  return items.length ? addDiceJobs(items, { onProgress, max: 20 }) : { added: 0, filtered: 0, checked: 0 };
}

export async function markApplied(id, applied = true) {
  const reqs = await get("reqs", {}); const r = reqs[id]; if (!r) return;
  if (applied) Object.assign(r, { status: "applied", appliedAt: new Date().toISOString(), submittedAt: r.submittedAt || new Date().toISOString(), submittedClient: r.submittedClient || r.client || "" });
  else Object.assign(r, { status: "new", appliedAt: null });
  await put({ reqs });
  if (applied) await logActivity({ kind: "applied", reqId: id, role: r.role, to: r.vendor + ` (${r.site || "Dice"})`, vendor: r.vendor, template: "", ok: true });
  await updateBadge();
}

// What the panel on a Dice job page shows.
export const diceInfo = id => reqInfo("dice:" + id);

// What the panel on a Dice job page shows for one requirement.
export async function reqInfo(id) {
  const [reqs, resumes, s] = await Promise.all([get("reqs", {}), get("resumes", []), settings()]);
  const r = reqs[id];
  if (!r) return { found: false };
  const must = r.must || [];
  const { textHas } = await import("./extract.js");
  const best = resumes.map(x => ({ name: x.name, hit: must.filter(k => textHas(x.text || "", k)) })).sort((a, b) => b.hit.length - a.hit.length)[0];
  return {
    found: true, id: r.id, role: r.role, company: r.vendor, status: r.status, appliedAt: r.appliedAt || null, repliedAt: r.repliedAt || null, filterReason: r.filterReason || "",
    email: r.from || "", years: r.experienceYears, myYears: Number(s.maxYears) || 5, visaFit: r.visaFit, visa: r.visa || "", clearance: !!r.clearance, rate: r.rate || "", location: r.location || "",
    skills: best ? { resume: best.name, hit: best.hit.length, total: must.length, gaps: must.filter(k => !best.hit.includes(k)) } : { resume: "", hit: 0, total: must.length, gaps: must }
  };
}

// ---------- Dice application confirmations ----------
// Dice emails "Application for <title> at <company> sent" after you apply. Each one marks the matching Dice job
// Applied, or adds it as Applied if it isn't in the dashboard yet, so the duplicate guard knows about it.
export async function scanDiceApplications(s) {
  const seen = await get("diceAppSeen", {});
  const res = await G.listThreads(`from:applyonline@dice.com newer_than:${Math.max(7, Number(s.lookbackDays) || 30)}d`, "", 50);
  const todo = (res.threads || []).filter(t => seen[t.id] !== t.historyId);
  if (!todo.length) return { marked: 0, added: 0 };
  const reqs = await get("reqs", {});
  const dice = Object.values(reqs).filter(r => r.source === "dice" || (r.source === "board" && r.site === "Dice"));
  let marked = 0, added = 0;
  for (const t of todo) {
    const meta = await G.getThreadMeta(t.id);
    for (const m of meta.messages || []) {
      const a = Dice.parseApplyConfirm(G.header(m, "Subject"));
      if (!a) continue;
      const at = new Date(Number(m.internalDate) || Date.now()).toISOString();
      const ck = Dice.companyKey(a.company);
      const match = dice.find(r => roleSimilarity(r.role, a.title) >= 0.6 && (!ck || Dice.companyKey(r.vendor) === ck || Dice.companyKey(r.client) === ck));
      if (match) {
        if (match.status !== "applied") { Object.assign(match, { status: "applied", appliedAt: at, submittedAt: match.submittedAt || at, filterReason: "" }); marked++; }
        continue;
      }
      const id = "diceapp:" + (a.title + "|" + ck).toLowerCase().replace(/[^a-z0-9|]+/g, "-");
      if (reqs[id]) continue;
      reqs[id] = { id, source: "dice", role: a.title, subject: a.title, vendor: a.company, client: "", location: a.location, mode: "", type: "", terms: "", rate: "",
        experienceYears: null, visa: "", visaFit: "unknown", clearance: false, must: [], nice: [], from: "", recruiterName: "",
        url: "https://www.dice.com/jobs?q=" + encodeURIComponent(a.title + " " + a.company), received: at, snippet: "Applied on Dice", body: "",
        status: "applied", appliedAt: at, submittedAt: at, fetchedAt: new Date().toISOString(), extractedBy: "dice-confirmation" };
      dice.push(reqs[id]); added++;
    }
    seen[t.id] = t.historyId;
  }
  await put({ reqs: { ...(await get("reqs", {})), ...Object.fromEntries(dice.map(r => [r.id, reqs[r.id]])) }, diceAppSeen: seen });
  if (marked || added) await logActivity({ kind: "applied", reqId: "", role: `${marked + added} Dice application${marked + added === 1 ? "" : "s"} from Dice's confirmation emails`, to: "Dice", vendor: "Dice", template: "", ok: true });
  return { marked, added };
}

// ---------- job boards ----------
// The job titles from your profile (or the titles you match on, if the profile has none).
export const jobTitlesOf = s => String(s.profile?.jobTitles || s.roleKeywords || "").split(/[;,\n]/).map(x => x.trim()).filter(x => x.length > 2);

// Jobs from Indeed, ZipRecruiter, Glassdoor and Monster alert emails, posted within the last boardHours.
export async function scanBoardAlerts(s, onProgress = () => {}) {
  const hours = Number(s.boardHours) || 24, since = Date.now() - hours * 36e5;
  const seen = await get("boardSeen", {});
  const q = `newer_than:${Math.max(1, Math.ceil(hours / 24))}d {${Boards.BOARDS.map(b => "from:" + b.from).join(" ")}}`;
  const res = await G.listThreads(q, "", 50);
  const muted = await get("muted", {});
  const reqs = await get("reqs", {}), fresh = {};
  // what this check saw, shown next to "Check job boards now"
  const st = { at: new Date().toISOString(), hours, emails: 0, sites: {}, found: 0, tooOld: 0, already: 0, added: 0, filtered: 0, olderEmails: 0 };
  for (const t of res.threads || []) {
    const meta = await G.getThreadMeta(t.id);
    for (const m of meta.messages || []) {
      const site = Boards.boardOf(G.header(m, "From"));
      if (!site) continue;
      if (Number(m.internalDate) < since) { st.olderEmails++; continue; }
      // an alert is read again only if the time window was widened since it was last read
      const prev = seen["m:" + m.id];
      if (prev && (prev.hours || 0) >= hours) { st.emails++; st.sites[site] = (st.sites[site] || 0) + 1; st.already += prev.jobs || 0; continue; }
      onProgress({ label: `Reading ${site} job alerts…` });
      const full = await G.getMessage(m.id);
      st.emails++; st.sites[site] = (st.sites[site] || 0) + 1;
      const jobs = Boards.parseAlert(G.bodyHtml(full), site, Number(m.internalDate));
      st.found += jobs.length;
      for (const j of jobs) {
        if (j.postedAt < since) { st.tooOld++; continue; }
        const r = Boards.toRequirement(j);
        if (reqs[r.id] || fresh[r.id]) { st.already++; continue; }
        const why = autoFilter(r, s, muted);
        if (why) { r.status = "filtered"; r.filterReason = why; st.filtered++; } else st.added++;
        fresh[r.id] = r;
      }
      seen["m:" + m.id] = { at: Date.now(), hours, jobs: jobs.length };
    }
  }
  for (const [k, v] of Object.entries(seen)) if (Date.now() - (v?.at || v || 0) > 10 * DAY) delete seen[k];
  await put({ reqs: { ...(await get("reqs", {})), ...fresh }, boardSeen: seen, boardsLast: st });
  return st;
}

// Startup jobs from Hacker News' monthly "Who is hiring?" thread, posted within the last boardHours. Runs every few hours.
export async function scanStartups(s, { force = false } = {}) {
  const every = Math.max(1, Number(s.diceSearchEveryHours) || 3) * 36e5;
  if (!force && Date.now() - (await get("hnAt", 0)) < every) return null;
  await put({ hnAt: Date.now() });
  const hours = Math.max(Number(s.boardHours) || 24, 24);
  const { thread, posts } = await HN.recentPosts(hours);
  const muted = await get("muted", {}), reqs = await get("reqs", {}), fresh = {};
  let added = 0, filtered = 0, already = 0, withEmail = 0;
  for (const r of posts) {
    if (reqs[r.id]) { already++; continue; }
    const why = autoFilter(r, s, muted);
    if (why) { r.status = "filtered"; r.filterReason = why; filtered++; } else { added++; if (r.from) withEmail++; }
    fresh[r.id] = r;
  }
  if (Object.keys(fresh).length) await put({ reqs: { ...(await get("reqs", {})), ...fresh } });
  return { thread: thread?.title || "", posts: posts.length, added, filtered, already, withEmail };
}

// Dice searches for each job title in your profile, posted within the last boardHours. Runs every few hours.
export async function searchDiceTitles(s, { force = false, onProgress = () => {} } = {}) {
  const every = Math.max(1, Number(s.diceSearchEveryHours) || 3) * 36e5;
  const last = await get("diceSearchAt", 0);
  if (!force && Date.now() - last < every) return null;
  await put({ diceSearchAt: Date.now() });
  const hours = Number(s.boardHours) || 10, items = [], seenIds = new Set();
  let searched = 0, failed = 0;
  for (const title of jobTitlesOf(s).slice(0, 4)) {
    try {
      onProgress({ label: `Searching Dice for "${title}"…` });
      const html = await (await fetch(Dice.searchUrl({ ...s, diceQuery: title, dicePosted: 1 }), { credentials: "include" })).text();
      Dice.idsFromHtml(html).slice(0, 12).forEach(x => { if (!seenIds.has(x.id)) { seenIds.add(x.id); items.push(x); } });
      searched++;
    } catch (e) { failed++; }
    await sleep(1000);
  }
  const r = items.length ? await addDiceJobs(items, { max: 24, maxAgeHours: hours, onProgress }) : { added: 0, filtered: 0, checked: 0 };
  return { ...r, searched, failed, found: items.length };
}

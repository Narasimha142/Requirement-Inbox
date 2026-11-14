import * as G from "./lib/gmail.js";
import { textHas, variants, emailOf, domainOf, sameJob } from "./lib/extract.js";
import { get, put, groups, fill, fillClean, syncNow, fetchSummary, sendBulk, draftReply, sendExistingDraft, updateBadge, settings as loadSettings, followUpDue, autoFilter, markApplied, scanBoardAlerts, searchDiceTitles, scanDiceApplications, scanStartups, DEFAULT_TEMPLATES, DEFAULT_SETTINGS, VISA_TYPES } from "./lib/sync.js";
import { testGemini } from "./lib/ai.js";
import { DEFAULT_ROLE_KEYWORDS } from "./lib/extract.js";

const STATUS = { new: "Awaiting reply", draft: "In drafts", replied: "Replied", answered: "Recruiter replied", applied: "Applied", skipped: "Skipped", filtered: "Filtered out" };
const srcOf = r => r?.source === "dice" ? "dice" : r?.startup ? "startup" : r?.source === "board" ? "board" : "email";
const isApplyJob = r => r?.source === "dice" || r?.source === "board"; // you apply on the site
const siteOf = r => r?.source === "board" ? r.site : "Dice";
const canSend = r => !!r.from; // has an email address to write to (recruiter emails, and postings that list one)
const statusLabel = (st, r) => isApplyJob(r) && st === "new" ? "Not applied" : STATUS[st];
const FIT = { ok: "OPT accepted", check: "Visa unclear", no: "USC / GC only", unknown: "Visa not stated" };
const DAY = 864e5;
const TABS = [["reqs", "Requirements"], ["replies", "Replies & interviews"], ["followups", "Follow-ups"], ["vendors", "Vendors"], ["reports", "Reports"], ["profile", "Profile"], ["templates", "Templates"], ["resumes", "Resumes"], ["log", "Reply log"], ["settings", "Settings"]];
const VARS = [["first_name", "recruiter's first name"], ["role", ""], ["location", ""], ["company", ""], ["my_name", ""], ["my_phone", ""], ["my_email", ""], ["my_visa", ""], ["my_visa_until", ""], ["my_years", ""], ["my_company", ""], ["my_title", ""], ["my_location", ""], ["my_availability", ""], ["my_rate", ""], ["my_linkedin", ""], ["my_skills", ""]];
const varList = () => VARS.map(([k]) => `<code class="var">{${k}}</code>`).join(" ");

const S = {
  account: null, reqs: {}, tpls: [], activity: [], resumes: [], notes: [], interviews: {}, muted: {}, sync: null, settings: { ...DEFAULT_SETTINGS },
  sel: new Set(), fsel: new Set(), q: "", filter: "new", age: 0, source: "all", quick: { opt: false, w2: false, local: false, rate: false },
  tab: TABS.some(t => t[0] === location.hash.slice(1)) ? location.hash.slice(1) : "reqs",
  busy: null, err: null, ready: false, tplId: "default", draftBody: null, confirm: false, progress: null, editTpl: null,
  verify: { email: "", msg: "", busy: false }, nextAt: null, previewResume: null, confirmReset: false, attachSel: null, gemini: null, boardsBusy: false
};
const resumeCache = new Map();

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = iso => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const fmtDay = iso => iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
const ago = iso => { if (!iso) return ""; const m = Math.round((Date.now() - Date.parse(iso)) / 6e4); if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; return `${Math.round(h / 24)} d ago`; };
const dur = ms => { const h = ms / 36e5; return h < 1 ? `${Math.max(1, Math.round(ms / 6e4))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
function toast(m, ms = 2800) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, ms); }
const myYears = () => Number(S.settings.myYears) || 0;
const allTpls = () => S.tpls.length ? S.tpls : DEFAULT_TEMPLATES;
const tplById = id => allTpls().find(t => t.id === id) || allTpls()[0];
const vendorOf = r => r.vendor || domainOf(r.from || "") || r.from;
const isDone = st => st === "replied" || st === "answered" || st === "applied";

// ---------- resumes ----------
function idb() { return new Promise((res, rej) => { const r = indexedDB.open("requirement-inbox", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbPut(key, val) { const d = await idb(); return new Promise((res, rej) => { const tx = d.transaction("files", "readwrite"); tx.objectStore("files").put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(key) { const d = await idb(); return new Promise((res, rej) => { const tx = d.transaction("files"); const q = tx.objectStore("files").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbDel(key) { const d = await idb(); return new Promise(res => { const tx = d.transaction("files", "readwrite"); tx.objectStore("files").delete(key); tx.oncomplete = res; tx.onerror = res; }); }
async function resumeBytes(id) { if (resumeCache.has(id)) return resumeCache.get(id); const b = await idbGet(id).catch(() => null); if (b) resumeCache.set(id, b); return b; }
const profileSkills = () => String(S.settings.profile?.skills || "");
const has = (resume, skill) => textHas(resume.text, skill) || textHas(profileSkills(), skill); // in the resume or listed in your profile
function coverage(resume, req) {
  const must = req.must || [], nice = req.nice || [];
  const mh = must.filter(s => has(resume, s)), nh = nice.filter(s => has(resume, s));
  return { mh, mm: must.filter(s => !mh.includes(s)), nh, nm: nice.filter(s => !nh.includes(s)), score: mh.length * 2 + nh.length };
}
function bestResume(req) {
  if (!S.resumes.length) return null;
  return S.resumes.map(r => ({ r, c: coverage(r, req) })).sort((a, b) => b.c.score - a.c.score || (b.r.isDefault ? 1 : 0) - (a.r.isDefault ? 1 : 0))[0];
}
// The resume to attach for a requirement: "none", "best" (best match for that role) or a resume id.
async function attachmentFor(choice, r) {
  if (!choice || choice === "none") return null;
  const meta = choice === "best" ? (bestResume(r)?.r || S.resumes.find(x => x.isDefault) || S.resumes[0]) : S.resumes.find(x => x.id === choice);
  if (!meta) return null;
  const bytes = await resumeBytes(meta.id);
  return bytes ? { filename: meta.name, mimeType: mimeOf(meta.kind), data: bytes } : null;
}
const attachLabel = c => !c || c === "none" ? "No attachment" : c === "best" ? "Best-matching resume" : (S.resumes.find(x => x.id === c)?.name || "A resume that was deleted");
const attachOptions = (cur, withNone = true) => `${withNone ? `<option value="none" ${!cur || cur === "none" ? "selected" : ""}>No attachment</option>` : ""}<option value="best" ${cur === "best" ? "selected" : ""}>Best-matching resume for each role</option>${S.resumes.map(x => `<option value="${esc(x.id)}" ${cur === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}`;
const mimeOf = kind => kind === "pdf" ? "application/pdf" : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain";

// ---------- state ----------
async function load() {
  const o = await chrome.storage.local.get(["account", "reqs", "templates", "activity", "resumes", "resumeMeta", "sync", "settings", "notes", "interviews", "muted", "boardsAt", "boardsLast"]);
  S.boardsAt = o.boardsAt || null; S.boardsLast = o.boardsLast || null;
  S.account = o.account || null; S.reqs = o.reqs || {}; S.activity = o.activity || []; S.sync = o.sync || null;
  S.settings = await loadSettings(); S.notes = o.notes || []; S.interviews = o.interviews || {}; S.muted = o.muted || {};
  S.tpls = o.templates || [];
  if (S.tpls.length && !S.tpls.some(t => t.id === "posting") && !(await get("postingTplAdded", false))) { S.tpls = [...S.tpls, DEFAULT_TEMPLATES.find(t => t.id === "posting")]; await put({ templates: S.tpls, postingTplAdded: true }); }
  if (S.tpls.some(t => t.id === "resume" && t.attach === undefined)) { S.tpls = S.tpls.map(t => t.id === "resume" && t.attach === undefined ? { ...t, attach: "best" } : t); await put({ templates: S.tpls }); }
  // one-time upgrades from version 1.0
  if (S.tpls.length && !S.tpls.some(t => t.id === "followup")) { S.tpls = [...S.tpls, ...DEFAULT_TEMPLATES.filter(t => t.id !== "default" && !S.tpls.some(x => x.id === t.id))]; await put({ templates: S.tpls }); }
  S.resumes = o.resumes || [];
  if (!S.resumes.length && o.resumeMeta) {
    const old = await idbGet("resume").catch(() => null);
    S.resumes = [{ id: "r1", ...o.resumeMeta, isDefault: true }];
    if (old) await idbPut("r1", old);
    await put({ resumes: S.resumes }); await chrome.storage.local.remove("resumeMeta");
  }
  const a = await chrome.alarms.get("fetch"); S.nextAt = a ? a.scheduledTime : null;
  S.ready = true;
}
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || Object.keys(changes).every(k => ["lock", "ignored", "interviewSeen", "threadHist", "boardSeen", "diceSeen", "diceMailSeen", "diceSearchAt"].includes(k))) return;
  await load();
  // While you're filling in the profile, background fetching doesn't redraw the form under your cursor.
  if ($("#profile-form") && !("resumes" in changes) && !("settings" in changes)) { renderHeader(); return; }
  keepForm(render);
});
// Redraw, keeping whatever was typed into the profile form.
function keepForm(fn) {
  const f = $("#profile-form");
  if (!f) return fn();
  const vals = [...f.querySelectorAll("input, select, textarea")].map(el => [el.id || el.name + "=" + el.value, el.type === "checkbox" ? el.checked : el.value]);
  fn();
  const g = $("#profile-form"); if (!g) return;
  for (const [k, v] of vals) {
    const el = k.includes("=") ? g.querySelector(`input[name="${k.split("=")[0]}"][value="${CSS.escape(k.split("=").slice(1).join("="))}"]`) : g.querySelector("#" + CSS.escape(k));
    if (!el || el.type === "file") continue;
    if (el.type === "checkbox") el.checked = v; else el.value = v;
  }
}

// ---------- derived ----------
function dupMap(gs) {
  const leads = gs.map(g => g.lead), out = new Map();
  for (const g of gs) {
    if (g.status === "filtered") continue;
    const same = gs.filter(o => o !== g && o.status !== "filtered" && sameJob(g.lead, o.lead));
    if (!same.length) continue;
    const sub = same.find(o => o.all.some(x => x.submittedAt)), sx = sub?.all.find(x => x.submittedAt);
    const rep = same.find(o => isDone(o.status));
    out.set(g.lead.id, {
      vendors: [...new Set(same.map(o => vendorOf(o.lead)))],
      submitted: sx ? { vendor: vendorOf(sx), at: sx.submittedAt, client: sx.submittedClient || sx.client } : null,
      replied: rep ? { vendor: vendorOf(rep.ref), at: rep.ref.repliedAt || rep.ref.appliedAt, site: isApplyJob(rep.ref) ? siteOf(rep.ref) : "" } : null
    });
  }
  return out;
}
const localTokens = () => String(S.settings.myLocations || "").split(/[;,]/).map(x => x.trim().toLowerCase()).filter(x => x.length > 1 && !/^[a-z]{2}$/.test(x));
const isLocal = r => { const loc = `${r.location || ""} ${r.mode || ""}`.toLowerCase(); return localTokens().some(t => loc.includes(t)); };
const isW2 = r => /\bw2\b/i.test(`${r.terms} ${r.type} ${r.subject}`);
function counts(gs) { const c = { all: 0, new: 0, draft: 0, replied: 0, answered: 0, applied: 0, skipped: 0, filtered: 0, email: 0, dice: 0, board: 0, startup: 0 }; gs.forEach(g => { if (g.status !== "filtered") c[srcOf(g.lead)]++; }); gs.forEach(g => { c[g.status] = (c[g.status] || 0) + 1; if (g.status !== "filtered") c.all++; }); return c; }
function visibleGroups(gs) {
  const terms = S.q.toLowerCase().split(/\s+/).filter(Boolean), floor = Number(S.settings.rateFloor) || 0;
  return gs.filter(g => {
    const r = g.lead;
    if (S.filter === "all" ? g.status === "filtered" : g.status !== S.filter) return false;
    if (S.source !== "all" && srcOf(r) !== S.source) return false;
    if (S.age && Date.now() - Date.parse(r.received) > S.age * DAY) return false;
    if (S.quick.opt && r.visaFit !== "ok") return false;
    if (S.quick.w2 && !isW2(r)) return false;
    if (S.quick.local && !isLocal(r)) return false;
    if (S.quick.rate && floor && r.rateHourly && r.rateHourly < floor) return false;
    const hay = [r.role, r.vendor, r.client, r.location, r.mode, r.type, r.terms, r.from, r.subject, r.recruiterName, r.visa, r.filterReason, ...(r.must || []), ...(r.nice || [])].join(" ").toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}

// ---------- render ----------
function render() {
  renderHeader();
  if (!S.ready) return;
  if (!S.account) { renderOnboarding(); $("#replybar-root").innerHTML = ""; return; }
  if (!S.settings.profile?.done) { $("#banner").innerHTML = ""; $("#main").innerHTML = profileView(true); $("#replybar-root").innerHTML = ""; return; }
  const gs = groups(S.reqs), c = counts(gs);
  const unread = S.notes.filter(n => !n.read).length;
  const dueList = Object.values(S.reqs).filter(r => followUpDue(r, S.settings));
  const syncErr = S.sync?.error && (!S.sync.at || Date.parse(S.sync.errorAt) > Date.parse(S.sync.at)) ? S.sync.error : null;
  const err = S.err || syncErr;
  $("#banner").innerHTML = err ? `<div class="banner err" role="alert"><span>${esc(err)}</span><span class="row-flex">${/sign in/i.test(err) ? `<button class="btn sm" data-act="signin">Sign in</button>` : ""}<button class="btn sm" data-act="dismiss-err">Dismiss</button></span></div>`
    : S.busy ? `<div class="banner info" role="status"><span>${esc(S.busy.label)}${S.busy.total ? ` ${S.busy.done} of ${S.busy.total}` : ""}</span></div>`
    : S.sync?.aiError ? `<div class="banner info"><span>Gemini clean-up was skipped on the last fetch (${esc(S.sync.aiError.slice(0, 120))}). The free rules were used instead.</span></div>` : "";
  const stats = [["reqs:new", "Awaiting your reply", c.new], ["replies", "New replies & invites", unread], ["followups", "Follow-ups due", dueList.length], ["reqs:replied", "Replied / applied", c.replied + c.answered + c.applied], ["reqs:filtered", "Filtered out", c.filtered]];
  const tabCount = { reqs: c.all, replies: unread || null, followups: dueList.length || null, vendors: null, reports: null, templates: allTpls().length, resumes: S.resumes.length, log: S.activity.length, settings: null };
  let body = `<section class="stats" aria-label="Counts">${stats.map(([k, l, n]) => `<button class="stat" data-go="${k}" aria-pressed="${(S.tab + ":" + S.filter) === k || S.tab === k}"><span class="n">${n}</span><span class="l">${l}</span></button>`).join("")}</section>
    <nav class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}${tabCount[k] ? `<span class="c">${tabCount[k]}</span>` : ""}</button>`).join("")}</nav>`;
  const views = { reqs: () => reqsView(gs, c), replies: repliesView, followups: () => followupsView(gs, dueList), vendors: () => vendorsView(gs), reports: () => reportsView(gs), profile: () => profileView(false), templates: templatesView, resumes: resumesView, log: logView, settings: settingsView };
  body += views[S.tab]();
  const keep = document.activeElement?.id, pos = document.activeElement?.selectionStart;
  $("#main").innerHTML = body;
  if (keep === "q") { const q = $("#q"); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {} } }
  renderReplyBar(gs);
  if (S.tab === "resumes") paintResume($("#resume-preview"));
}
function renderHeader() {
  const r = $("#hdr-right");
  if (!S.account) { r.innerHTML = ""; return; }
  r.innerHTML = `<div style="display:grid;gap:4px;justify-items:end">
      <span class="acct" title="Verified Gmail account">✓ ${esc(S.account.email)}</span>
      <span class="syncline">${S.sync?.at ? `Last fetch ${esc(ago(S.sync.at))}` : "Not fetched yet"}${S.nextAt ? ` · next at ${esc(new Date(S.nextAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}` : ""}</span>
      ${S.sync?.pending ? `<span class="syncline">${S.sync.pending} older email${S.sync.pending === 1 ? "" : "s"} still to read, ${Number(S.settings.perFetch) || 30} per fetch</span>` : ""}</div>
    <button class="btn primary" data-act="sync" ${S.busy ? "disabled" : ""}>${S.busy ? "Fetching…" : "Fetch now"}</button>`;
}
function renderOnboarding() {
  $("#banner").innerHTML = "";
  const v = S.verify;
  $("#main").innerHTML = `<section class="panel onb"><form class="pad" id="verify-form">
    <h2>Connect your Gmail</h2>
    <p class="note">Enter the Gmail address recruiters write to. You'll sign in with Google, and the extension checks that the signed-in mailbox is this address before fetching anything. Your mail is read straight from Google by this extension; nothing goes to any other server.</p>
    <div class="f"><label for="v-email">Gmail address</label><input id="v-email" type="email" autocomplete="email" required value="${esc(v.email)}" placeholder="you@gmail.com"></div>
    ${v.msg ? `<p class="note" role="alert" style="color:var(--bad)">${esc(v.msg)}</p>` : ""}
    <div class="row-flex"><button class="btn primary" type="submit" ${v.busy ? "disabled" : ""}>${v.busy ? "Checking…" : "Sign in with Google and verify"}</button></div>
  </form></section>`;
}

// ---------- requirements ----------
function expChip(r) {
  const y = r.experienceYears; if (y === null || y === undefined || y === "") return "";
  const cls = y <= myYears() ? "ok" : y <= myYears() + 2 ? "check" : "no";
  return `<span class="pill ${cls}" title="Years asked vs your ${myYears()}">${esc(y)}+ yrs</span>`;
}
function skillChip(r) {
  const b = bestResume(r); if (!b || !(r.must || []).length) return "";
  const pct = Math.round(b.c.mh.length / r.must.length * 100);
  return `<span class="tag" title="Must-haves found in ${esc(b.r.name)}">${b.c.mh.length}/${r.must.length} skills <span class="meter"><i style="width:${pct}%"></i></span></span>`;
}
function statusLine(g) {
  const r = g.ref;
  if (g.status === "replied") return `Replied ${esc(fmt(r.repliedAt))}${r.followUpCount ? ` · ${r.followUpCount} follow-up${r.followUpCount > 1 ? "s" : ""}` : ""}`;
  if (g.status === "answered") return `Recruiter replied ${esc(fmt(r.recruiterRepliedAt))}`;
  if (g.status === "draft") return `Draft saved ${esc(fmt(r.draftAt))}`;
  if (g.status === "applied") return `Applied ${esc(fmt(r.appliedAt))}`;
  return `${srcOf(g.lead) === "email" ? "Received" : "Posted"} ${esc(fmt(g.lead.received))}`;
}
function dupLine(d) {
  if (!d) return "";
  if (d.submitted) return `<div class="dup warn">⚠ You already submitted${d.submitted.client ? ` to ${esc(d.submitted.client)}` : ""} via ${esc(d.submitted.vendor)} on ${esc(fmtDay(d.submitted.at))}. Submitting again can get you rejected.</div>`;
  if (d.replied) return `<div class="dup warn">Same role: you already ${d.replied.site ? `applied on ${d.replied.site} to` : "replied via"} ${esc(d.replied.vendor)} on ${esc(fmtDay(d.replied.at))}.</div>`;
  return `<div class="dup">Same role also sent by ${esc(d.vendors.slice(0, 3).join(", "))}${d.vendors.length > 3 ? ` and ${d.vendors.length - 3} more` : ""}.</div>`;
}
// What the last job-board check saw, in one line.
function boardsLine() {
  const b = S.boardsLast; if (!b) return "";
  const sites = Object.entries(b.sites || {}).map(([k, n]) => `${k}${n > 1 ? " ×" + n : ""}`).join(", ");
  const parts = b.emails
    ? [`${b.emails} alert email${b.emails === 1 ? "" : "s"} from the last ${b.hours} hours (${sites})`, `${b.added} new for you`, b.filtered ? `${b.filtered} filtered out` : "", b.already ? `${b.already} already listed` : "", b.tooOld ? `${b.tooOld} posted earlier than that` : ""]
    : [`no job-alert emails in the last ${b.hours} hours${b.olderEmails ? ` (${b.olderEmails} older one${b.olderEmails === 1 ? "" : "s"}; widen it under Settings → Job boards)` : ""}`];
  const d = b.dice ? ` · Dice: ${b.dice.searched ? `searched ${b.dice.searched} title${b.dice.searched === 1 ? "" : "s"}, ${b.dice.found} jobs, ${b.dice.added} new for you` : b.dice.failed ? "couldn't reach dice.com" : "no job titles in your profile"}` : "";
  const h = b.hn ? (b.hn.error ? " · Startups (Hacker News): couldn't be reached" : ` · Startups (Hacker News): ${b.hn.posts} new posts, ${b.hn.added} for you${b.hn.withEmail ? ` (${b.hn.withEmail} with an email to write to)` : ""}`) : "";
  return `<p class="note" style="margin:2px 0 0">Job boards checked ${esc(ago(b.at))}: ${esc(parts.filter(Boolean).join(", "))}${esc(d)}${esc(h)}.</p>`;
}
function reqsView(gs, c) {
  const vis = visibleGroups(gs), dups = dupMap(gs);
  const selectable = vis.filter(g => canSend(g.lead) && (g.status === "new" || g.status === "draft"));
  const allSel = selectable.length && selectable.every(g => S.sel.has(g.lead.id));
  const chips = [["new", "Awaiting reply", c.new], ["all", "All", c.all], ["draft", "In drafts", c.draft], ["replied", "Replied", c.replied], ["answered", "Recruiter replied", c.answered], ["applied", "Applied", c.applied], ["skipped", "Skipped", c.skipped], ["filtered", "Filtered out", c.filtered]];
  const floor = Number(S.settings.rateFloor) || 0;
  const quick = [["opt", "OPT accepted"], ["w2", "W2 only"], ["local", "Local"], ...(floor ? [["rate", `Rate ≥ $${floor}/hr`]] : [])];
  const rows = vis.map(g => {
    const r = g.lead, sel = S.sel.has(r.id), dice = isApplyJob(r), can = canSend(r) && (g.status === "new" || g.status === "draft");
    const where = [r.location, r.mode && !new RegExp(r.mode, "i").test(r.location || "") ? r.mode : ""].filter(Boolean).join(" · ");
    const terms = [r.type, r.terms, r.rate].filter(Boolean);
    const sub = g.all.find(x => x.submittedAt);
    return `<article class="req ${sel ? "sel" : ""}">
      <input type="checkbox" id="sel-${esc(r.id)}" data-sel="${esc(r.id)}" ${sel ? "checked" : ""} ${can ? "" : "disabled"} aria-label="Select ${esc(r.role)}">
      <div><div class="t">${esc(r.role)}</div>
        <div class="s">${esc(vendorOf(r))}${r.client ? " · client " + esc(r.client) : ""}${r.recruiterName ? " · " + esc(r.recruiterName) : ""}${where ? " · " + esc(where) : ""}</div></div>
      <div class="right"><span class="pill st-${g.status}">${statusLabel(g.status, r)}</span><span class="when">${statusLine(g)}</span></div>
      <div class="tags">${dice ? `<span class="pill dice">${esc(siteOf(r))}</span>` : ""}${g.status === "filtered" ? `<span class="pill no">Filtered: ${esc(r.filterReason)}</span>` : ""}<span class="pill ${r.visaFit === "no" ? "no" : esc(r.visaFit || "unknown")}">${FIT[r.visaFit] || FIT.unknown}</span>${expChip(r)}${terms.map(t => `<span class="tag">${esc(t)}</span>`).join("")}${skillChip(r)}${sub && !dice ? `<span class="pill ok">Submitted ${esc(fmtDay(sub.submittedAt))}</span>` : ""}${dice && r.from ? `<span class="pill ok" title="Recruiter contact from the posting">✉ ${esc(r.from)}${r.recruiterPhone ? " · " + esc(r.recruiterPhone) : ""}</span>` : dice && r.recruiterPhone ? `<span class="tag">☎ ${esc(r.recruiterPhone)}</span>` : ""}${g.all.length > 1 ? `<span class="tag">emailed ${g.all.length}×</span>` : ""}${r.extractedBy === "gemini" ? `<span class="tag" title="Details cleaned up by Gemini">AI</span>` : ""}</div>
      ${dupLine(dups.get(r.id))}
      <div class="acts">${(r.must || []).length || !dice ? `<button class="btn sm" data-skills="${esc(r.id)}">Show skills</button>` : ""}
        ${dice ? `<a class="btn sm ${r.from ? "" : "primary"}" href="${esc(r.url)}" target="_blank" rel="noopener">${r.site === "Hacker News" ? "Open post" : "Apply on " + esc(siteOf(r))}</a>${r.threadId ? `<a class="btn sm" href="https://mail.google.com/mail/#all/${esc(r.threadId)}" target="_blank" rel="noopener">Open in Gmail</a>` : ""}${g.status === "applied" ? `<button class="btn sm ghost" data-unapply="${esc(r.id)}">Undo applied</button>` : `<button class="btn sm" data-applied="${esc(r.id)}">Mark applied</button>`}`
          : `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Open in Gmail</a>`}
        ${g.status === "draft" && g.ref.draftId ? `<button class="btn sm" data-send-draft="${esc(g.ref.id)}">Send draft</button>` : ""}
        ${!dice && isDone(g.status) && !sub ? `<button class="btn sm" data-submit="${esc(g.ref.id)}">Mark submitted</button>` : ""}
        ${g.status === "new" ? `<button class="btn sm ghost" data-skip="${esc(r.id)}">Skip</button>` : g.status === "skipped" || g.status === "filtered" ? `<button class="btn sm ghost" data-unskip="${esc(r.id)}">Restore</button>` : ""}</div>
    </article>`;
  }).join("");
  return `<div class="row-flex"><input id="q" class="search" type="search" placeholder="Search role, skill, vendor, client, city or visa" aria-label="Search requirements" value="${esc(S.q)}"></div>
    <div class="row-flex" role="group" aria-label="Source"><span class="note">Source</span>${[["all", "All sources"], ["email", `Email · ${c.email}`], ["dice", `Dice · ${c.dice}`], ["board", `Job boards · ${c.board}`], ["startup", `Startups · ${c.startup}`]].map(([k, l]) => `<button class="chip sm" data-source="${k}" aria-pressed="${S.source === k}">${l}</button>`).join("")}<button class="btn sm" data-act="boards-now" ${S.boardsBusy ? "disabled" : ""}>${S.boardsBusy ? "Checking job boards…" : "Check job boards now"}</button><button class="btn sm ghost" data-act="dice-search">Open Dice search</button></div>
      ${boardsLine()}
    <div class="row-flex" role="group" aria-label="Status">${chips.map(([k, l, n]) => `<button class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${l}<span class="c">${n}</span></button>`).join("")}</div>
    <div class="row-flex filters"><span class="note">Received</span>${[[0, "Any time"], [1, "1 day"], [3, "3 days"], [7, "7 days"]].map(([d, l]) => `<button class="chip sm" data-age="${d}" aria-pressed="${S.age === d}">${l}</button>`).join("")}
      <span class="sep"></span>${quick.map(([k, l]) => `<button class="chip sm" data-quick="${k}" aria-pressed="${S.quick[k]}">${l}</button>`).join("")}</div>
    <section class="panel"><div class="panel-hd"><label class="tog"><input type="checkbox" id="sel-all" ${allSel ? "checked" : ""} ${selectable.length ? "" : "disabled"}> Select all ${selectable.length} you can reply to</label>
      <span class="note">${vis.length} shown · newest first · repeats merged</span></div>
      <div class="list">${rows || `<div class="empty">${Object.keys(S.reqs).length ? "Nothing matches these filters." : S.busy ? "Fetching your requirement emails…" : "No requirement emails yet. Press Fetch now."}</div>`}</div></section>`;
}

// ---------- reply bar (requirements + follow-ups) ----------
function renderReplyBar(gs) {
  const root = $("#replybar-root");
  requestAnimationFrame(() => { $("#app").style.paddingBottom = ((root.firstElementChild?.offsetHeight || 0) + 40) + "px"; });
  const isFollow = S.tab === "followups", set = isFollow ? S.fsel : S.sel;
  if (S.progress) {
    const p = S.progress, pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    root.innerHTML = `<div class="replybar"><div class="in"><div class="prog"><strong>${esc(p.label)}</strong> ${p.done} of ${p.total}${p.failed ? ` · ${p.failed} need a look` : ""}<div class="bar"><i style="width:${pct}%"></i></div></div>
      ${p.finished ? `<div class="row-flex">${p.errors.length ? `<span class="note" style="color:var(--bad)">${esc(p.errors.slice(0, 3).join(" · "))}</span>` : ""}<button class="btn" data-act="close-progress">Done</button></div>` : ""}</div></div>`;
    return;
  }
  if (!(S.tab === "reqs" || isFollow) || !set.size) { root.innerHTML = ""; return; }
  const chosen = gs.filter(g => set.has(g.lead.id));
  const first = chosen[0]?.lead;
  const tpl = tplById(isFollow && S.tplId === "default" ? "followup" : S.tplId), body = S.draftBody ?? tpl.body;
  const dups = isFollow ? new Map() : dupMap(gs);
  const risky = chosen.filter(g => dups.get(g.lead.id)?.submitted || dups.get(g.lead.id)?.replied);
  const noun = isFollow ? "follow-up" : "repl";
  const n = set.size, word = isFollow ? `follow-up${n === 1 ? "" : "s"}` : `repl${n === 1 ? "y" : "ies"}`;
  root.innerHTML = `<div class="replybar" role="region" aria-label="Reply to selected"><div class="in">
    <div class="row-flex" style="justify-content:space-between"><strong>${n} selected${isFollow ? " for follow-up" : ""}</strong>
      <div class="row-flex"><label class="note" for="tpl-pick">Template</label><select id="tpl-pick">${allTpls().map(t => `<option value="${esc(t.id)}" ${t.id === tpl.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
      <button class="btn ghost sm" data-act="clear-sel">Clear</button></div></div>
    ${risky.length ? `<div class="dup warn">⚠ ${risky.length} of these look like roles you already answered through another vendor: ${esc(risky.slice(0, 3).map(g => g.lead.role).join(", "))}. <button class="btn sm" data-act="drop-risky">Unselect them</button></div>` : ""}
    <textarea id="reply-body" aria-label="Message">${esc(body)}</textarea>
    <div class="row-flex"><label class="note" for="rb-attach">Attach</label><select id="rb-attach">${attachOptions(S.attachSel ?? tpl.attach ?? "none")}</select>${(S.attachSel ?? tpl.attach) && (S.attachSel ?? tpl.attach) !== "none" && !S.resumes.length ? `<span class="note" style="color:var(--bad)">No resume saved yet. Add one on the Profile or Resumes tab.</span>` : ""}</div>
    <p class="note">${first ? `Preview for ${esc(first.role)}: “${esc(fillClean(body, first, { ...S.settings, account: S.account }).split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 170))}…”` : ""} Variables: ${varList()}</p>
    ${S.confirm ? `<div class="confirm row-flex" style="justify-content:space-between"><span>Send ${n} ${word} from ${esc(S.account.email)} now? Each goes to that recruiter only, in the same thread${(S.attachSel ?? tpl.attach ?? "none") !== "none" ? `, with ${esc(attachLabel(S.attachSel ?? tpl.attach).toLowerCase())} attached` : ""}.</span><span class="row-flex"><button class="btn" data-act="cancel-send">Cancel</button><button class="btn primary" data-act="do-send">Yes, send ${n}</button></span></div>`
      : `<div class="row-flex" style="justify-content:flex-end"><button class="btn" data-act="save-tpl">Save as template</button>${isFollow ? "" : `<button class="btn" data-act="drafts">Save as drafts</button>`}<button class="btn primary" data-act="send">Send ${n} ${word}</button></div>`}
  </div></div>`;
}

// ---------- replies & interviews ----------
function calendarUrl(iv) {
  const p = new URLSearchParams({ action: "TEMPLATE", text: (iv.subject || "Interview").replace(/^(re|fw|fwd|invitation):\s*/i, ""), details: `${iv.snippet || ""}\n\nEmail: ${iv.url || ""}` });
  const w = iv.when;
  if (w && w.h !== null && w.h !== undefined) {
    const pad = n => String(n).padStart(2, "0");
    const start = `${w.y}${pad(w.m + 1)}${pad(w.d)}T${pad(w.h)}${pad(w.min)}00`;
    const endH = w.h + 1;
    p.set("dates", `${start}/${w.y}${pad(w.m + 1)}${pad(w.d)}T${pad(endH)}${pad(w.min)}00`);
    if (w.tz) p.set("ctz", w.tz);
  } else if (w) {
    const pad = n => String(n).padStart(2, "0"); const d0 = `${w.y}${pad(w.m + 1)}${pad(w.d)}`;
    const nx = new Date(w.y, w.m, w.d + 1); p.set("dates", `${d0}/${nx.getFullYear()}${pad(nx.getMonth() + 1)}${pad(nx.getDate())}`);
  }
  return "https://calendar.google.com/calendar/render?" + p.toString();
}
const whenText = w => !w ? "Time not found in the email" : new Date(w.y, w.m, w.d, w.h ?? 0, w.min || 0).toLocaleString([], { weekday: "short", month: "short", day: "numeric", ...(w.h !== null && w.h !== undefined ? { hour: "numeric", minute: "2-digit" } : {}) }) + (w.tz ? ` (${w.tz.split("/")[1].replace("_", " ")} time)` : "");
function repliesView() {
  const ivs = Object.values(S.interviews).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const notes = S.notes;
  const ivRows = ivs.map(iv => `<div class="note-row"><div><div class="t">${esc((iv.subject || "Interview").replace(/^(re|fw|fwd):\s*/i, ""))}</div>
      <div class="s">${esc(iv.from)} · ${esc(whenText(iv.when))}</div><div class="s">${esc((iv.snippet || "").slice(0, 220))}</div></div>
      <div class="acts">${iv.inCalendar ? `<span class="pill ok">In your calendar</span>` : `<a class="btn sm primary" href="${esc(calendarUrl(iv))}" target="_blank" rel="noopener">Add to Google Calendar</a>`}<a class="btn sm" href="${esc(iv.url)}" target="_blank" rel="noopener">Open email</a></div></div>`).join("");
  const noteRows = notes.map(n => {
    const r = S.reqs[n.reqId];
    return `<div class="note-row ${n.read ? "" : "unread"}"><div><div class="t">${n.read ? "" : `<span class="dot" aria-label="unread"></span>`}${esc(n.title)}</div>
      <div class="s">${esc(fmt(n.at))}</div>${n.body ? `<div class="s quote">${esc(n.body.slice(0, 300))}</div>` : ""}</div>
      <div class="acts">${r ? `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Open in Gmail</a>` : ""}
        ${n.kind === "reply" && r ? `<button class="btn sm primary" data-draft="${esc(r.id)}">Draft reply</button>${!r.submittedAt ? `<button class="btn sm" data-submit="${esc(r.id)}">Mark submitted</button>` : `<span class="pill ok">Submitted</span>`}` : ""}
        ${n.kind === "followup" ? `<button class="btn sm" data-tab="followups">See follow-ups</button>` : ""}
        ${n.read ? "" : `<button class="btn sm ghost" data-read="${esc(n.id)}">Mark read</button>`}</div></div>`;
  }).join("");
  return `<section class="panel"><div class="panel-hd"><h2>Interviews</h2><span class="note">Spotted in recruiter replies and invites from the last 7 days</span></div>
      <div class="list">${ivRows || `<div class="empty">No interview invites found yet.</div>`}</div></section>
    <section class="panel"><div class="panel-hd"><h2>Recruiter replies and alerts</h2>${notes.some(n => !n.read) ? `<button class="btn sm" data-act="read-all">Mark all read</button>` : ""}</div>
      <div class="list">${noteRows || `<div class="empty">When a recruiter answers one of your replies, it shows here with their message. Nothing is sent automatically: use <strong>Draft reply</strong> to put a reply (with your resume) in Gmail drafts.</div>`}</div></section>`;
}

// ---------- follow-ups ----------
function followupsView(gs, dueList) {
  const dueIds = new Set(dueList.map(r => r.id));
  const due = gs.filter(g => g.all.some(x => dueIds.has(x.id))).map(g => ({ ...g, lead: g.all.find(x => dueIds.has(x.id)) }));
  const soon = Object.values(S.reqs).filter(r => r.status === "replied" && !dueIds.has(r.id) && !r.recruiterRepliedAt && (r.followUpCount || 0) < (Number(S.settings.maxFollowUps) || 2)).sort((a, b) => Date.parse(a.lastSentAt || a.repliedAt) - Date.parse(b.lastSentAt || b.repliedAt));
  const allSel = due.length && due.every(g => S.fsel.has(g.lead.id));
  const row = (r, can) => `<article class="req ${S.fsel.has(r.id) ? "sel" : ""}">
      <input type="checkbox" data-fsel="${esc(r.id)}" ${S.fsel.has(r.id) ? "checked" : ""} ${can ? "" : "disabled"} aria-label="Select ${esc(r.role)}">
      <div><div class="t">${esc(r.role)}</div><div class="s">${esc(vendorOf(r))}${r.recruiterName ? " · " + esc(r.recruiterName) : ""} · ${esc(r.from)}</div></div>
      <div class="right"><span class="pill ${can ? "check" : "unknown"}">${can ? `No reply in ${esc(dur(Date.now() - Date.parse(r.lastSentAt || r.repliedAt)))}` : `Due ${esc(fmtDay(new Date(Date.parse(r.lastSentAt || r.repliedAt) + (Number(S.settings.followUpDays) || 3) * DAY).toISOString()))}`}</span>
        <span class="when">Last sent ${esc(fmt(r.lastSentAt || r.repliedAt))}${r.followUpCount ? ` · ${r.followUpCount} follow-up${r.followUpCount > 1 ? "s" : ""} so far` : ""}</span></div>
      <div class="acts"><a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Open in Gmail</a></div></article>`;
  return `<section class="panel"><div class="panel-hd"><label class="tog"><input type="checkbox" id="fsel-all" ${allSel ? "checked" : ""} ${due.length ? "" : "disabled"}> Select all ${due.length} due</label>
      <span class="note">Recruiters who haven't answered in ${esc(S.settings.followUpDays)} days · at most ${esc(S.settings.maxFollowUps)} follow-ups each</span></div>
      <div class="list">${due.map(g => row(g.lead, true)).join("") || `<div class="empty">No follow-ups due. Recruiters who don't answer within ${esc(S.settings.followUpDays)} days show up here.</div>`}</div></section>
    ${soon.length ? `<section class="panel"><div class="panel-hd"><h2>Coming up</h2></div><div class="list">${soon.slice(0, 20).map(r => row(r, false)).join("")}</div></section>` : ""}`;
}

// ---------- vendors ----------
function vendorStats(gs) {
  const map = new Map();
  for (const r of Object.values(S.reqs)) {
    const d = domainOf(r.from || ""); if (!d) continue;
    const v = map.get(d) || { domain: d, name: r.vendor || d, recruiters: new Set(), emails: 0, roles: new Set(), replied: 0, answered: 0, resp: [], last: 0, filtered: 0 };
    v.emails++; v.recruiters.add(r.from); v.roles.add(groupKeyLite(r)); v.last = Math.max(v.last, Date.parse(r.received));
    if (r.status === "filtered") v.filtered++;
    if (isDone(r.status)) v.replied++;
    if (r.recruiterRepliedAt) { v.answered++; if (r.repliedAt) v.resp.push(Date.parse(r.recruiterRepliedAt) - Date.parse(r.repliedAt)); }
    map.set(d, v);
  }
  return [...map.values()].map(v => ({ ...v, roles: v.roles.size, repeats: v.emails - v.roles.size, rate: v.replied ? v.answered / v.replied : null, avg: v.resp.length ? v.resp.reduce((a, b) => a + b, 0) / v.resp.length : null }))
    .sort((a, b) => b.emails - a.emails);
}
const groupKeyLite = r => (r.from || "") + "|" + String(r.subject || "").toLowerCase().replace(/^(re|fw|fwd):\s*/i, "").replace(/\s+/g, " ").trim();
function vendorsView(gs) {
  const list = vendorStats(gs);
  const rows = list.map(v => {
    const muted = !!S.muted[v.domain];
    return `<tr class="${muted ? "muted" : ""}"><td><strong>${esc(v.name)}</strong><div class="s">${esc(v.domain)} · ${v.recruiters.size} recruiter${v.recruiters.size === 1 ? "" : "s"}</div></td>
      <td class="num">${v.roles}</td><td class="num">${v.repeats ? `<span class="pill ${v.repeats >= 3 ? "no" : "check"}">${v.repeats}</span>` : "0"}</td>
      <td class="num">${v.replied}</td><td class="num">${v.answered}</td>
      <td class="num">${v.rate === null ? "–" : Math.round(v.rate * 100) + "%"}</td><td class="num">${v.avg === null ? "–" : esc(dur(v.avg))}</td>
      <td class="mono">${esc(fmtDay(new Date(v.last).toISOString()))}</td>
      <td><button class="btn sm ${muted ? "" : "danger"}" data-mute="${esc(v.domain)}">${muted ? "Unmute" : "Mute"}</button></td></tr>`;
  }).join("");
  return `<section class="panel"><div class="panel-hd"><h2>Vendor scorecard</h2><span class="note">Muting a vendor files its requirements under Filtered out, now and in future fetches.</span></div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Vendor</th><th class="num">Roles sent</th><th class="num">Repeat emails</th><th class="num">You replied</th><th class="num">They replied</th><th class="num">Reply rate</th><th class="num">Avg response</th><th>Last email</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">Vendors appear after the first fetch.</div>`}</section>`;
}

// ---------- reports ----------
function weekStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function barChart({ title, series, labels, colors, names, height = 230 }) {
  const W = 1100, H = height, L = 40, B = 28, T = 12, n = labels.length, k = series.length;
  const max = Math.max(1, ...series.flat());
  const step = Math.max(1, Math.ceil(max / 4)), top = step * Math.ceil(max / step);
  const bw = (W - L - 10) / n, gw = Math.min(30, (bw - 24) / k);
  const y = v => T + (H - T - B) * (1 - v / top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" class="chart">`;
  for (let v = 0; v <= top; v += step) svg += `<line x1="${L}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}</text>`;
  labels.forEach((lab, i) => {
    const x0 = L + i * bw + (bw - gw * k) / 2;
    series.forEach((s, j) => { const v = s[i]; if (v) svg += `<rect x="${x0 + j * gw}" y="${y(v)}" width="${gw - 2}" height="${y(0) - y(v)}" rx="2" fill="${colors[j]}"><title>${esc(names[j])}: ${v}</title></rect>`; });
    svg += `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle" class="ax">${esc(lab)}</text>`;
  });
  return svg + `</svg>`;
}
function hbars(items, color) {
  const max = Math.max(1, ...items.map(i => i[1]));
  return `<div class="hbars">${items.map(([l, v, hint]) => `<div class="hb"><span class="hl">${esc(l)}</span><span class="hbar"><i style="width:${v / max * 100}%;background:${hint || color}"></i></span><span class="hv">${v}</span></div>`).join("")}</div>`;
}
function reportsView(gs) {
  const reqs = Object.values(S.reqs), now = Date.now();
  const weeks = Array.from({ length: 8 }, (_, i) => weekStart(now) - (7 - i) * 7 * DAY);
  const idx = t => { const w = weekStart(t); const i = weeks.indexOf(w); return i; };
  const recv = weeks.map(() => 0), sent = weeks.map(() => 0), answered = weeks.map(() => 0);
  gs.filter(g => g.status !== "filtered").forEach(g => { const i = idx(Date.parse(g.lead.received)); if (i >= 0) recv[i]++; });
  S.activity.filter(a => a.ok !== false && (a.kind === "sent" || a.kind === "draft-sent" || a.kind === "followup")).forEach(a => { const i = idx(Date.parse(a.at)); if (i >= 0) sent[i]++; });
  reqs.filter(r => r.recruiterRepliedAt).forEach(r => { const i = idx(Date.parse(r.recruiterRepliedAt)); if (i >= 0) answered[i]++; });
  const labels = weeks.map(w => new Date(w).toLocaleDateString([], { month: "short", day: "numeric" }));
  const repliedTotal = reqs.filter(r => isDone(r.status)).length, answeredTotal = reqs.filter(r => r.status === "answered").length;
  const thisWeekSent = sent[7], thisWeekRecv = recv[7];
  const skills = new Map();
  gs.filter(g => g.status !== "filtered").forEach(g => (g.lead.must || []).forEach(s => skills.set(s, (skills.get(s) || 0) + 1)));
  const topSkills = [...skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const fits = { ok: 0, check: 0, unknown: 0, no: 0 }; gs.forEach(g => { fits[g.lead.visaFit || "unknown"] = (fits[g.lead.visaFit || "unknown"] || 0) + 1; });
  const reasons = new Map(); reqs.filter(r => r.status === "filtered").forEach(r => reasons.set(r.filterReason, (reasons.get(r.filterReason) || 0) + 1));
  const kpi = (n, l) => `<div class="kpi"><span class="n">${n}</span><span class="l">${l}</span></div>`;
  return `<div class="kpis">${kpi(thisWeekRecv, "Requirements this week")}${kpi(thisWeekSent, "Replies sent this week")}${kpi(repliedTotal ? Math.round(answeredTotal / repliedTotal * 100) + "%" : "–", "Recruiters who answered you")}${kpi(Object.keys(S.interviews).length, "Interview invites")}</div>
    <section class="panel"><div class="panel-hd"><h2>Week by week</h2><div class="legend"><span style="--c:var(--accent)">Requirements received</span><span style="--c:var(--violet)">Replies you sent</span><span style="--c:var(--good)">Recruiters who answered</span></div></div>
      <div class="pad">${barChart({ title: "Requirements, replies and answers per week", series: [recv, sent, answered], labels, colors: ["var(--accent)", "var(--violet)", "var(--good)"], names: ["Requirements received", "Replies you sent", "Recruiters who answered"] })}</div></section>
    <div class="grid2"><section class="panel"><div class="panel-hd"><h2>Most requested skills</h2><span class="note">Must-haves across requirements you can apply to · green = in one of your resumes</span></div>
        <div class="pad">${topSkills.length ? hbars(topSkills.map(([s, v]) => [s, v, S.resumes.some(r => textHas(r.text, s)) ? "var(--good)" : "var(--accent)"]), "var(--accent)") : `<p class="note">Appears after the first fetch.</p>`}</div></section>
      <section class="panel"><div class="panel-hd"><h2>Visa fit and filters</h2></div><div class="pad">
        ${hbars([["OPT accepted", fits.ok, "var(--good)"], ["Visa unclear", fits.check, "var(--warn)"], ["Visa not stated", fits.unknown, "var(--muted)"], ["USC / GC only", fits.no, "var(--bad)"]])}
        ${reasons.size ? `<div class="sec-title">Filtered out by reason</div>${hbars([...reasons.entries()], "var(--muted)")}` : ""}</div></section></div>`;
}

// ---------- profile ----------
const EMP_TYPES = ["W2", "C2C", "1099", "Full-time", "Contract to hire"];
const WORK_MODES = ["Remote", "Hybrid", "Onsite"];
function profileView(first = false) {
  const s = S.settings, p = s.profile || {};
  const box = (name, list, on) => `<div class="row-flex">${list.map(v => `<label class="tog"><input type="checkbox" name="${name}" value="${esc(v)}" ${(on || []).includes(v) ? "checked" : ""}> ${esc(v)}</label>`).join("")}</div>`;
  const titles = p.jobTitles || s.roleKeywords || "";
  return `<form id="profile-form" class="${first ? "onb-wide" : ""}">
    ${first ? `<section class="panel"><div class="pad"><h2>Tell us about you</h2><p class="note">Gmail is connected as ${esc(S.account.email)} and your requirements are being fetched in the background. These details fill in your reply templates, decide which roles are kept for you, and pick which jobs to search for on the job boards. Everything stays on this computer. You can change any of it later on the Profile tab.</p></div></section>` : ""}
    <div class="grid2">
    <section class="panel"><div class="pad"><h2>Personal</h2>
      <div class="f"><label for="p-name">Full name</label><input id="p-name" autocomplete="name" value="${esc(s.myName)}" required></div>
      <div class="f"><label for="p-phone">Phone</label><input id="p-phone" type="tel" autocomplete="tel" value="${esc(p.phone)}" placeholder="(555) 123-4567"></div>
      <div class="f"><label for="p-loc">Current location</label><input id="p-loc" value="${esc(p.location)}" placeholder="e.g. Dallas, TX"></div>
      <div class="f"><label for="p-li">LinkedIn profile URL</label><input id="p-li" type="url" value="${esc(p.linkedin)}" placeholder="https://www.linkedin.com/in/…"></div>
      <div class="f"><label for="p-reloc">Open to relocation</label><select id="p-reloc">${["", "Yes", "No", "Within my state"].map(v => `<option value="${esc(v)}" ${p.relocate === v ? "selected" : ""}>${v || "Not specified"}</option>`).join("")}</select></div>
    </div></section>
    <section class="panel"><div class="pad"><h2>Work authorization</h2>
      <div class="f"><label for="p-visa">Visa / work authorization</label><select id="p-visa" required><option value="">Choose…</option>${VISA_TYPES.map(v => `<option ${p.visa === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
      <div class="f"><label for="p-visa-until">Valid until (optional)</label><input id="p-visa-until" type="date" value="${esc(p.visaUntil)}"></div>
      <p class="note">Used in templates as <code class="var">{my_visa}</code>. Green Card and US Citizen holders never have "USC / GC only" roles filtered out.</p>
      <h2>Current employment</h2>
      <div class="f"><label for="p-co">Current company</label><input id="p-co" value="${esc(p.company)}"></div>
      <div class="f"><label for="p-title">Current job title</label><input id="p-title" value="${esc(p.title)}"></div>
      <div class="f"><label for="p-years">Total years of experience</label><input id="p-years" type="number" min="0" max="45" step="0.5" value="${esc(s.myYears)}" required></div>
      <div class="f"><label for="p-avail">Availability / notice period</label><input id="p-avail" value="${esc(p.availability)}" placeholder="e.g. Immediately, 2 weeks"></div>
    </div></section>
    <section class="panel"><div class="pad"><h2>Jobs you want</h2>
      <div class="f"><label for="p-titles">Job titles (separate with ;)</label><textarea id="p-titles" style="min-height:80px" required>${esc(titles)}</textarea><span class="note">Roles are kept when their title contains one of these, and the first few are searched on Dice. <button class="btn sm ghost" type="button" data-act="kw-reset">Use software engineer titles</button></span></div>
      <div class="f"><label for="p-skills">Your skills (separate with commas)</label><textarea id="p-skills" style="min-height:80px" placeholder="Java, Spring Boot, React, Angular, AWS, SQL">${esc(p.skills)}</textarea><span class="note">Counted as "you have it" in skill gaps, alongside your resumes.</span></div>
      <div class="f"><label>Employment types</label>${box("p-emp", EMP_TYPES, p.empTypes)}</div>
      <div class="f"><label>Work setting</label>${box("p-mode", WORK_MODES, p.workModes)}</div>
      <div class="f"><label for="p-local">Cities you count as local (separate with ;)</label><input id="p-local" value="${esc(s.myLocations)}" placeholder="Dallas, TX; Irving; Plano; Remote"></div>
      <div class="f"><label for="p-rate">Expected rate</label><input id="p-rate" value="${esc(p.rate)}" placeholder="e.g. $60/hr on C2C"></div>
      <div class="f"><label for="p-salary">Expected salary (full-time)</label><input id="p-salary" value="${esc(p.salary)}" placeholder="e.g. $110K"></div>
      <div class="f"><label for="p-floor">Hide roles paying under ($/hr, 0 = show all)</label><input id="p-floor" type="number" min="0" max="400" value="${esc(s.rateFloor)}"></div>
    </div></section>
    <section class="panel"><div class="pad"><h2>Resume</h2>
      <p class="note">Upload one or more versions (PDF, Word or text). Templates can attach the one that best matches each role.</p>
      <div class="list">${S.resumes.map(r => `<div class="tpl"><div class="row-flex" style="justify-content:space-between"><strong>${esc(r.name)}</strong>${r.isDefault ? `<span class="pill ok">Default</span>` : ""}</div><span class="note">${esc(fmt(r.uploadedAt))} · ${(r.text || "").split(/\s+/).filter(Boolean).length} words</span></div>`).join("") || `<div class="empty">No resume yet.</div>`}</div>
      <label class="btn" for="resume-file" style="cursor:pointer;justify-self:start">Upload resume</label><input type="file" id="resume-file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden>
    </div></section>
    </div>
    <div class="row-flex savebar">${first ? `<button class="btn ghost" type="button" data-act="skip-profile">Skip for now</button>` : ""}<button class="btn primary" type="submit">${first ? "Save profile" : "Save profile"}</button></div>
  </form>`;
}

// ---------- templates / log / resumes / settings ----------
function templatesView() {
  return `<div class="grid2"><section class="panel"><div class="panel-hd"><h2>Your templates</h2></div>
    ${allTpls().map(t => `<div class="tpl"><div class="row-flex" style="justify-content:space-between"><span><strong>${esc(t.name)}</strong>${t.attach && t.attach !== "none" ? ` <span class="pill ok">📎 ${esc(attachLabel(t.attach))}</span>` : ""}</span><span class="row-flex"><button class="btn sm" data-edit-tpl="${esc(t.id)}">Edit</button>${allTpls().length > 1 ? `<button class="btn sm danger" data-del-tpl="${esc(t.id)}">Delete</button>` : ""}</span></div><pre>${esc(t.body)}</pre></div>`).join("")}</section>
    <section class="panel"><form class="pad" id="tpl-form"><h2>${S.editTpl ? "Edit template" : "New template"}</h2>
      <div class="f"><label for="t-name">Name</label><input id="t-name" required value="${esc(S.editTpl?.name || "")}" placeholder="e.g. Send resume"></div>
      <div class="f"><label for="t-body">Message</label><textarea id="t-body" required>${esc(S.editTpl?.body || "")}</textarea></div>
      <div class="f"><label for="t-attach">Attach resume</label><select id="t-attach">${attachOptions(S.editTpl?.attach || "none")}</select><span class="note">Used whenever you send with this template. "Best-matching" picks, for each role, the saved resume that covers the most required skills.</span></div>
      <p class="note">Variables fill in per email from the requirement and your Profile: ${varList()}. A line such as "Phone: {my_phone}" is left out when that detail is empty.</p>
      <div class="row-flex"><button class="btn primary" type="submit">${S.editTpl ? "Save changes" : "Add template"}</button>${S.editTpl ? `<button class="btn" type="button" data-act="cancel-tpl">Cancel</button>` : ""}</div></form></section></div>`;
}
function logView() {
  const label = k => ({ sent: "Reply sent", draft: "Draft saved", "draft-sent": "Draft sent", followup: "Follow-up sent", applied: "Marked applied" })[k] || k;
  const rows = S.activity.map(a => `<tr><td class="mono">${esc(fmt(a.at))}</td><td>${esc(label(a.kind))}</td><td>${esc(a.role || "")}</td><td>${esc(a.to || "")}</td><td>${esc(a.template || "")}</td><td>${a.ok === false ? `<span class="pill no">${esc(a.error || "Failed")}</span>` : `<span class="pill ok">Done</span>`}</td></tr>`).join("");
  return `<section class="panel"><div class="panel-hd"><h2>Reply log</h2><span class="note">Every reply, follow-up and draft from the extension, newest first.</span></div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Role</th><th>To</th><th>Template</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">Nothing sent from here yet.</div>`}</section>`;
}
function resumesView() {
  const cur = S.resumes.find(r => r.id === S.previewResume) || S.resumes.find(r => r.isDefault) || S.resumes[0];
  if (cur) S.previewResume = cur.id;
  return `<div class="grid-side"><section class="panel"><div class="panel-hd"><h2>Resume versions</h2>
      <label class="btn primary sm" for="resume-file" style="cursor:pointer">Add resume</label><input type="file" id="resume-file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden></div>
      <div class="list">${S.resumes.map(r => `<div class="tpl ${r.id === cur?.id ? "cur" : ""}"><div class="row-flex" style="justify-content:space-between"><button class="linkish" data-preview="${esc(r.id)}"><strong>${esc(r.name)}</strong></button>${r.isDefault ? `<span class="pill ok">Default</span>` : ""}</div>
        <span class="note">${esc(fmt(r.uploadedAt))} · ${(r.text || "").split(/\s+/).filter(Boolean).length} words</span>
        <div class="row-flex">${r.isDefault ? "" : `<button class="btn sm" data-default="${esc(r.id)}">Make default</button>`}<button class="btn sm danger" data-del-resume="${esc(r.id)}">Delete</button></div></div>`).join("") || `<div class="empty">Add your resumes (PDF, Word or text), for example one Java-heavy and one front-end. <strong>Show skills</strong> picks the best match for each role. They stay on this computer.</div>`}</div></section>
    <section class="panel"><div class="panel-hd"><h2>${cur ? esc(cur.name) : "Preview"}</h2></div><div class="pad">${cur ? `<div class="resume-view" id="resume-preview"><span class="note">Loading preview…</span></div>` : `<p class="note">No resume yet.</p>`}</div></section></div>`;
}
function settingsView() {
  const s = S.settings;
  const chk = (id, on, label) => `<label class="tog"><input type="checkbox" id="${id}" ${on ? "checked" : ""}> ${label}</label>`;
  const opt = (id, val, list) => `<select id="${id}">${list.map(([v, l]) => `<option value="${v}" ${String(val) === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  return `<form id="settings-form" class="grid2">
    <section class="panel"><div class="pad"><h2>Match my profile</h2>
      ${chk("s-prof", s.profileOnly, "Keep only roles that match my profile (email, Dice and job boards)")}
      <p class="note">The job titles you match on are on the <button class="linkish" type="button" data-tab="profile">Profile</button> tab.</p>
      <div class="f"><label for="s-maxy">Most years a role can ask for</label>${opt("s-maxy", s.maxYears, [[3, "3 years"], [4, "4 years"], [5, "5 years"], [6, "6 years"], [7, "7 years"], [8, "8 years"]])}</div>
      <div class="f"><label for="s-slack">Allow a little over</label>${opt("s-slack", s.yearsSlack, [[0, "No, exactly that"], [1, "1 year over (\"nearly\")"], [2, "2 years over"]])}</div>
      ${chk("s-senior", s.skipSeniorTitles, "Skip Principal, Staff, Architect, Manager and Director titles")}
      <p class="note">Roles that don't say how many years are kept. Anything left out stays under <strong>Filtered out</strong>.</p>
    </div></section>
    <section class="panel"><div class="pad"><h2>Dice</h2>
      ${chk("s-dalerts", s.diceAlerts, "Read Dice job-alert emails from Gmail on every fetch")}
      <div class="f"><label for="s-dq">Dice search</label><input id="s-dq" value="${esc(s.diceQuery)}"></div>
      <div class="f"><label for="s-dloc">Location</label><input id="s-dloc" value="${esc(s.diceLocation)}" placeholder="e.g. Dallas, TX"></div>
      <div class="f"><label for="s-dpost">Posted within</label>${opt("s-dpost", s.dicePosted, [[1, "1 day"], [3, "3 days"], [7, "7 days"], [0, "Any time"]])}</div>
      ${chk("s-drem", s.diceRemote, "Remote only")}
      <p class="note">To get Dice jobs automatically, run this search on Dice once and click <strong>Create job alert</strong> (daily). The extension reads those alert emails every hour. Jobs on Dice pages you browse are also checked and saved, and clicking Apply on Dice is recorded here.</p>
    </div></section>
    <section class="panel"><div class="pad"><h2>Job boards</h2>
      ${chk("s-boards", s.boardsOn, "Read job-alert emails from Indeed, ZipRecruiter, Glassdoor, Monster, and the startup sites Wellfound, Built In and RemoteHunter")}
      ${chk("s-startups", s.startupsOn, "Startup jobs from Hacker News' monthly \"Who is hiring?\" thread")}
      ${chk("s-dsearch", s.diceSearchOn, "Search Dice for my profile's job titles")}
      <div class="f"><label for="s-bhours">Only jobs posted in the last</label>${opt("s-bhours", s.boardHours, [[6, "6 hours"], [10, "10 hours"], [12, "12 hours"], [24, "24 hours (recommended)"], [48, "2 days"], [72, "3 days"]])}</div>
      <div class="f"><label for="s-devery">Search Dice every</label>${opt("s-devery", s.diceSearchEveryHours, [[1, "1 hour"], [2, "2 hours"], [3, "3 hours"], [6, "6 hours"]])}</div>
      <p class="note">These run after each email fetch and show under <strong>Source: Job boards</strong> and <strong>Dice</strong>, filtered by your profile. Startup jobs show under <strong>Startups</strong>. You apply on each site; when a posting lists a recruiter email, you can also select it and send your template from here. To get more, turn on job alerts for your titles on Indeed, ZipRecruiter, Glassdoor, Monster, Wellfound and Built In; the extension reads those emails.${S.boardsAt ? ` Last checked ${esc(ago(S.boardsAt))}.` : ""}</p>
    </div></section>
    <section class="panel"><div class="pad"><h2>Filters</h2>
      ${chk("s-clear", s.excludeClearance, "Leave out roles that need a security clearance")}
      ${chk("s-cit", s.excludeCitizenOnly, "Leave out roles that accept only US citizens or green card holders")}
      <p class="note">Roles that don't mention visa rules are always fetched. Filtered roles stay under <strong>Filtered out</strong> so you can restore any of them. Job boards, newsletters and alerts are skipped automatically.</p>
      <h2>Fetching</h2>
      <div class="f"><label for="s-int">Fetch every</label>${opt("s-int", s.intervalMin, [[15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"]])}</div>
      <div class="f"><label for="s-per">Emails to read per fetch</label>${opt("s-per", s.perFetch, [[15, "15 newest"], [30, "30 newest (recommended)"], [50, "50 newest"]])}</div>
      <div class="f"><label for="s-back">How far back to look</label>${opt("s-back", s.lookbackDays, [[1, "Last 1 day"], [3, "Last 3 days"], [7, "Last 7 days"], [30, "Last 30 days"]])}</div>
    </div></section>
    <section class="panel"><div class="pad"><h2>Alerts</h2>
      ${chk("s-nnew", s.notifyNew, "Desktop alert for new requirements")}
      ${chk("s-nrep", s.notifyReplies, "Desktop alert when a recruiter replies or sends an interview invite")}
      ${chk("s-nfol", s.notifyFollowUps, "Desktop alert when follow-ups are due")}
      ${chk("s-mail", s.emailAlerts, `Also email me a summary at ${esc(S.account.email)}`)}
      <h2>Follow-ups</h2>
      <div class="f"><label for="s-fdays">Remind me when a recruiter hasn't replied in</label>${opt("s-fdays", s.followUpDays, [[2, "2 days"], [3, "3 days"], [5, "5 days"], [7, "7 days"]])}</div>
      <div class="f"><label for="s-fmax">Most follow-ups per recruiter</label>${opt("s-fmax", s.maxFollowUps, [[1, "1"], [2, "2"], [3, "3"]])}</div>
    </div></section>
    <section class="panel"><div class="pad"><h2>Better extraction with Gemini (optional, free)</h2>
      <p class="note">Paste a free API key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> to have Gemini clean up role, client, rate and visa rules from messy emails. Leave it empty to use the built-in rules only. On the free tier Google may use what's sent to improve its models, so don't use it if that's a concern.</p>
      <div class="f"><label for="s-key">Gemini API key</label><input id="s-key" type="password" autocomplete="off" value="${esc(s.geminiKey)}" placeholder="AIza…"></div>
      <div class="f"><label for="s-model">Model</label><input id="s-model" value="${esc(s.geminiModel)}"><span class="note">If this model isn't available to your key, a newer one is used automatically.</span></div>
      <div class="row-flex"><button class="btn sm" type="button" data-act="test-gemini" ${S.gemini?.busy ? "disabled" : ""}>${S.gemini?.busy ? "Testing…" : "Test key"}</button>${S.gemini && !S.gemini.busy ? `<span class="pill ${S.gemini.ok ? "ok" : "no"}">${esc(S.gemini.message)}</span>` : ""}</div>
      ${S.sync?.aiError ? `<p class="note" style="color:var(--bad)">Last fetch: Gemini was skipped (${esc(S.sync.aiError.slice(0, 140))}).</p>` : ""}
      <h2>Account</h2>
      <p class="note">Signed in as ${esc(S.account.email)} since ${esc(fmt(S.account.verifiedAt))}.</p>
      <div class="row-flex"><button class="btn" type="button" data-act="signout">Sign out</button><button class="btn danger" type="button" data-act="reset">Remove all fetched data</button></div>
      ${S.confirmReset ? `<div class="banner err"><span>Remove every fetched requirement, alert and the reply log? Your Gmail isn't touched.</span><span class="row-flex"><button class="btn sm" type="button" data-act="cancel-reset">Cancel</button><button class="btn sm danger" type="button" data-act="do-reset">Remove</button></span></div>` : ""}
    </div></section>
    <div class="row-flex savebar"><button class="btn primary" type="submit">Save settings</button></div></form>`;
}

// ---------- resume parsing + preview ----------
window.pdfjsLib && (window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js"));
async function readResume(file) {
  const buf = await file.arrayBuffer(), lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf") || file.type === "application/pdf") {
    const doc = await window.pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise; let text = "";
    for (let p = 1; p <= doc.numPages; p++) { const tc = await (await doc.getPage(p)).getTextContent(); text += tc.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n\n"; }
    return { buf, text, kind: "pdf" };
  }
  if (lower.endsWith(".docx")) { const out = await window.mammoth.extractRawText({ arrayBuffer: buf.slice(0) }); return { buf, text: out.value, kind: "docx" }; }
  return { buf, text: new TextDecoder().decode(buf), kind: "txt" };
}
async function paintResume(el) {
  const meta = S.resumes.find(r => r.id === S.previewResume);
  if (!el || !meta) return;
  const token = (paintResume.t = (paintResume.t || 0) + 1);
  const bytes = await resumeBytes(meta.id);
  if (token !== paintResume.t || !el.isConnected) return;
  try {
    if (bytes && meta.kind === "pdf") {
      const doc = await window.pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise; el.innerHTML = "";
      for (let p = 1; p <= doc.numPages; p++) { const page = await doc.getPage(p); const vp = page.getViewport({ scale: 1.4 }); const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; el.appendChild(c); await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise; }
      return;
    }
    if (bytes && meta.kind === "docx") { const out = await window.mammoth.convertToHtml({ arrayBuffer: bytes.slice(0) }); el.innerHTML = `<div class="doc">${out.value}</div>`; return; }
  } catch (e) { /* text below */ }
  el.innerHTML = `<div class="resume-text" style="width:100%">${esc(meta.text || "")}</div>`;
}
function highlighted(text, skills) {
  const html = esc(text);
  const terms = [...new Set(skills.flatMap(variants))].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return html;
  const re = new RegExp("(^|[^a-z0-9+#.])(" + terms.map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![a-z0-9+#])", "gi");
  return html.replace(re, (m, pre, w) => `${pre}<mark>${w}</mark>`);
}

// ---------- modals ----------
const modal = html => { $("#modal-root").innerHTML = `<div class="scrim" data-close-scrim>${html}</div>`; $("#modal-root [data-close]")?.focus(); };
const closeModal = () => { $("#modal-root").innerHTML = ""; };
function openSkills(id, resumeId) {
  const r = S.reqs[id]; if (!r) return;
  const best = bestResume(r);
  const res = S.resumes.find(x => x.id === resumeId) || best?.r || null;
  const cov = res ? coverage(res, r) : null;
  const must = r.must || [], nice = r.nice || [], y = r.experienceYears;
  const item = (s, hit) => `<div class="sk-item ${hit ? "hit" : "miss"}"><span>${esc(s)}</span><span>${hit ? "In resume" : "Gap"}</span></div>`;
  const plain = s => `<div class="sk-item" style="background:var(--sunk)">${esc(s)}</div>`;
  const ranking = S.resumes.length > 1 ? S.resumes.map(x => ({ x, c: coverage(x, r) })).sort((a, b) => b.c.score - a.c.score) : [];
  modal(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="sk-title">
    <header><div><h2 id="sk-title">${esc(r.role)}</h2><p class="note">${esc(vendorOf(r))}${r.client ? " · client " + esc(r.client) : ""}${r.location ? " · " + esc(r.location) : ""}</p></div><button class="btn" data-close>Close</button></header>
    <div class="bd"><div class="verdict">
        <div class="row-flex"><span class="pill ${r.visaFit === "no" ? "no" : esc(r.visaFit || "unknown")}">${FIT[r.visaFit] || FIT.unknown}</span>${y !== null && y !== undefined ? `<span class="pill ${y <= myYears() ? "ok" : y <= myYears() + 2 ? "check" : "no"}">Asks ${esc(y)}+ years · you have ${myYears()}</span>` : ""}${cov && must.length ? `<span class="pill ${cov.mm.length ? "check" : "ok"}">${cov.mh.length} of ${must.length} must-haves in ${esc(res.name)}</span>` : ""}${r.clearance ? `<span class="pill no">Clearance required</span>` : ""}</div>
        ${r.visa ? `<p class="note">Visa line in the email: “${esc(r.visa)}”</p>` : ""}
        ${cov && cov.mm.length ? `<p class="note"><strong>Skill gaps:</strong> ${esc(cov.mm.join(", "))}</p>` : ""}
        ${ranking.length ? `<div class="row-flex"><span class="note">Your resumes for this role:</span>${ranking.map(({ x, c }, i) => `<button class="chip sm" data-skills="${esc(r.id)}" data-resume="${esc(x.id)}" aria-pressed="${x.id === res.id}">${i === 0 ? "★ " : ""}${esc(x.name)} · ${c.mh.length}/${must.length}</button>`).join("")}</div>` : ""}</div>
      <div class="sk-grid">
        <div><div class="sec-title" style="margin-bottom:6px">${res ? esc(res.name) + " · matched skills highlighted" : "Your resume"}</div>
          ${res ? `<div class="resume-text" style="background:var(--bg);max-height:62vh;overflow:auto">${highlighted(res.text, cov.mh.concat(cov.nh))}</div>` : `<div class="empty" style="background:var(--bg);border-radius:10px">No resume saved yet. <button class="btn sm" data-act="go-resume">Add resume</button></div>`}</div>
        <div style="display:grid;gap:14px">
          <div><div class="sec-title" style="margin-bottom:6px">Must-have</div><div class="sk-list">${must.length ? (cov ? cov.mm.map(s => item(s, false)).join("") + cov.mh.map(s => item(s, true)).join("") : must.map(plain).join("")) : `<p class="note">No skills found in this email.</p>`}</div></div>
          ${nice.length ? `<div><div class="sec-title" style="margin-bottom:6px">Nice to have</div><div class="sk-list">${cov ? cov.nm.map(s => item(s, false)).join("") + cov.nh.map(s => item(s, true)).join("") : nice.map(plain).join("")}</div></div>` : ""}
          <details><summary class="note" style="cursor:pointer">Read the email</summary><div class="resume-text" style="background:var(--bg);max-height:40vh;overflow:auto;margin-top:8px">${esc(r.body || r.snippet || "")}</div></details>
          <a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Open in Gmail</a>
        </div></div></div></div>`);
}
function openDraft(id) {
  const r = S.reqs[id]; if (!r) return;
  const tpl = tplById(allTpls().some(t => t.id === "resume") ? "resume" : S.tplId);
  const best = bestResume(r);
  modal(`<form class="modal narrow" id="draft-form" data-req="${esc(id)}" role="dialog" aria-modal="true" aria-labelledby="dr-title">
    <header><div><h2 id="dr-title">Draft a reply</h2><p class="note">${esc(r.role)} · ${esc(r.recruiterName || r.from)}</p></div><button class="btn" type="button" data-close>Close</button></header>
    <div class="bd">${r.recruiterReplySnippet ? `<div class="verdict"><span class="sec-title">They wrote</span><span class="note">${esc(r.recruiterReplySnippet)}</span></div>` : ""}
      <div class="f"><label for="dr-tpl">Template</label><select id="dr-tpl">${allTpls().map(t => `<option value="${esc(t.id)}" ${t.id === tpl.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
      <div class="f"><label for="dr-body">Message</label><textarea id="dr-body">${esc(fillClean(tpl.body, r, { ...S.settings, account: S.account }))}</textarea></div>
      <div class="f"><label for="dr-resume">Attach resume</label><select id="dr-resume"><option value="">No attachment</option>${S.resumes.map(x => { const pick = tpl.attach === "best" ? best?.r.id : tpl.attach; return `<option value="${esc(x.id)}" ${x.id === pick ? "selected" : ""}>${esc(x.name)}${x.id === best?.r.id ? " (best match)" : ""}</option>`; }).join("")}</select></div>
      <p class="note">This saves a draft in Gmail, in the same thread. Nothing is sent until you open it in Gmail and press Send.</p>
      <div class="row-flex" style="justify-content:flex-end"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Save draft in Gmail</button></div></div></form>`);
}
function openSubmit(id) {
  const r = S.reqs[id]; if (!r) return;
  modal(`<form class="modal narrow" id="submit-form" data-req="${esc(id)}" role="dialog" aria-modal="true" aria-labelledby="sb-title">
    <header><div><h2 id="sb-title">Mark as submitted</h2><p class="note">${esc(r.role)} via ${esc(vendorOf(r))}</p></div><button class="btn" type="button" data-close>Close</button></header>
    <div class="bd"><div class="f"><label for="sb-client">End client</label><input id="sb-client" value="${esc(r.client || "")}" placeholder="e.g. Bank of America"></div>
      <p class="note">You'll be warned if another vendor sends the same role for this client.</p>
      <div class="row-flex" style="justify-content:flex-end"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Mark submitted</button></div></div></form>`);
}

// ---------- actions ----------
async function runSync(by = "manual") {
  if (S.busy) return;
  S.busy = { label: "Starting…" }; S.err = null; render();
  try {
    const r = await syncNow({ interactive: true, by, onProgress: p => { S.busy = p; render(); } });
    if (r.skipped === "already fetching") toast("A fetch is already running in the background.");
    else toast(fetchSummary(r), 8000);
  } catch (e) { S.err = e.message || String(e); }
  S.busy = null; await load(); render();
}
async function verify(email) {
  S.verify = { email, msg: "", busy: true }; render();
  try {
    const p = await G.profile(true);
    const actual = (p?.emailAddress || "").toLowerCase();
    if (actual !== email) {
      await G.signOut();
      S.verify = { email, msg: `You signed in as ${actual || "a different account"}, not ${email}. Sign in with ${email}, or enter ${actual} instead. If Chrome keeps picking the wrong account, sign Chrome itself into ${email}.`, busy: false };
      render(); return;
    }
    await put({ account: { email, verifiedAt: new Date().toISOString() } });
    if (!(await get("templates", [])).length) await put({ templates: DEFAULT_TEMPLATES });
    S.verify = { email: "", msg: "", busy: false };
    await load(); render(); toast("Gmail verified. Fetching your requirements…");
    runSync("first");
  } catch (e) { S.verify = { email, msg: e.message || String(e), busy: false }; render(); }
}
async function bulk(mode) {
  const isFollow = S.tab === "followups", set = isFollow ? S.fsel : S.sel;
  const gs = groups(S.reqs).filter(g => g.all.some(x => set.has(x.id))).map(g => ({ ...g, lead: g.all.find(x => set.has(x.id)) }));
  const tpl = tplById(isFollow && S.tplId === "default" ? "followup" : S.tplId);
  const body = $("#reply-body")?.value ?? tpl.body;
  const tplName = (S.draftBody !== null && S.draftBody !== tpl.body) ? tpl.name + " (edited)" : tpl.name;
  const m = isFollow ? "followup" : mode;
  S.confirm = false;
  S.progress = { label: m === "draft" ? "Saving drafts" : m === "followup" ? "Sending follow-ups" : "Sending replies", done: 0, total: gs.length, failed: 0, errors: [], finished: false }; render();
  try { await G.getToken(true); } catch (e) { S.progress.errors.push(e.message); S.progress.finished = true; render(); return; }
  const choice = S.attachSel ?? tpl.attach ?? "none";
  const res = await sendBulk({ groupsToSend: gs, body, tplName, mode: m, attachFor: r => attachmentFor(choice, r), onProgress: p => { Object.assign(S.progress, p); renderReplyBar(groups(S.reqs)); } });
  Object.assign(S.progress, res, { finished: true });
  set.clear(); S.draftBody = null; S.attachSel = null; await load(); render();
  const ok = res.done - res.failed;
  toast(m === "draft" ? `Saved ${ok} draft${ok === 1 ? "" : "s"} in Gmail` : `Sent ${ok} ${m === "followup" ? "follow-up" : "repl"}${m === "followup" ? (ok === 1 ? "" : "s") : (ok === 1 ? "y" : "ies")}`);
}
async function setStatus(id, status) {
  const g = groups(S.reqs).find(x => x.lead.id === id || x.all.some(y => y.id === id));
  const reqs = await get("reqs", {});
  for (const x of (g?.all || [])) if (reqs[x.id]) { reqs[x.id].status = status; if (status === "new") reqs[x.id].filterReason = ""; }
  await put({ reqs }); S.sel.delete(id); await updateBadge();
}
// After settings change: re-check every requirement you haven't acted on.
async function refilter() {
  const s = await loadSettings(), muted = await get("muted", {}), reqs = await get("reqs", {});
  let moved = 0;
  for (const r of Object.values(reqs)) {
    if (r.status !== "new" && !(r.status === "filtered" && r.filterReason !== "Muted vendor")) continue;
    const why = autoFilter(r, s, muted);
    const status = why ? "filtered" : "new";
    if (status !== r.status || (why || "") !== (r.filterReason || "")) { r.status = status; r.filterReason = why; moved++; }
  }
  if (moved) { await put({ reqs }); await updateBadge(); toast(`Settings saved. ${moved} requirement${moved === 1 ? "" : "s"} re-sorted to match.`); }
}
async function toggleMute(domain) {
  const muted = { ...S.muted }, reqs = await get("reqs", {});
  if (muted[domain]) {
    delete muted[domain];
    for (const r of Object.values(reqs)) if (domainOf(r.from || "") === domain && r.status === "filtered" && r.filterReason === "Muted vendor") { r.status = "new"; r.filterReason = autoFilter({ ...r, from: "" }, S.settings, {}) || ""; if (r.filterReason) r.status = "filtered"; }
    toast("Vendor unmuted");
  } else {
    muted[domain] = { at: new Date().toISOString() };
    for (const r of Object.values(reqs)) if (domainOf(r.from || "") === domain && r.status === "new") { r.status = "filtered"; r.filterReason = "Muted vendor"; }
    toast("Vendor muted. Its requirements moved to Filtered out.");
  }
  await put({ muted, reqs }); await updateBadge();
}

document.addEventListener("click", async e => {
  if (e.target.matches("[data-close-scrim]")) return closeModal();
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset;
  if (b.matches("[data-close]")) return closeModal();
  if (d.tab) { S.tab = d.tab; S.editTpl = null; S.confirm = false; S.draftBody = null; history.replaceState(null, "", "#" + d.tab); closeModal(); render(); return; }
  if (d.go) { const [tab, f] = d.go.split(":"); S.tab = tab; if (f) S.filter = f; history.replaceState(null, "", "#" + tab); render(); return; }
  if (d.filter) { S.filter = d.filter; render(); return; }
  if (d.age !== undefined) { S.age = Number(d.age); render(); return; }
  if (d.source) { S.source = d.source; render(); return; }
  if (d.applied) { await markApplied(d.applied, true); toast("Marked applied"); return; }
  if (d.unapply) { await markApplied(d.unapply, false); return; }
  if (d.quick) { S.quick[d.quick] = !S.quick[d.quick]; render(); return; }
  if (d.skills) return openSkills(d.skills, d.resume);
  if (d.skip) return setStatus(d.skip, "skipped");
  if (d.unskip) return setStatus(d.unskip, "new");
  if (d.submit) return openSubmit(d.submit);
  if (d.draft) return openDraft(d.draft);
  if (d.mute) return toggleMute(d.mute);
  if (d.read) { await put({ notes: S.notes.map(n => n.id === d.read ? { ...n, read: true } : n) }); await updateBadge(); return; }
  if (d.preview) { S.previewResume = d.preview; render(); return; }
  if (d.default) { await put({ resumes: S.resumes.map(r => ({ ...r, isDefault: r.id === d.default })) }); return; }
  if (d.delResume) { const rest = S.resumes.filter(r => r.id !== d.delResume); if (rest.length && !rest.some(r => r.isDefault)) rest[0].isDefault = true; await idbDel(d.delResume); resumeCache.delete(d.delResume); await put({ resumes: rest }); toast("Resume deleted"); return; }
  if (d.sendDraft) { try { await G.getToken(true); await sendExistingDraft(d.sendDraft); toast("Draft sent"); } catch (err) { S.err = err.message; render(); } return; }
  if (d.editTpl) { S.editTpl = allTpls().find(t => t.id === d.editTpl) || null; render(); $("#t-name")?.focus(); return; }
  if (d.delTpl) { await put({ templates: allTpls().filter(t => t.id !== d.delTpl) }); if (S.tplId === d.delTpl) S.tplId = "default"; toast("Template deleted"); return; }
  switch (d.act) {
    case "sync": return runSync("manual");
    case "dice-search": chrome.runtime.sendMessage({ type: "open-dice-search" }); toast("Opening Dice. Jobs on the results pages you view are checked against your profile and saved here.", 5000); return;
    case "signin": try { await G.getToken(true); S.err = null; runSync("manual"); } catch (err) { S.err = err.message; render(); } return;
    case "dismiss-err": S.err = null; if (S.sync?.error) await put({ sync: { ...S.sync, error: null } }); return render();
    case "clear-sel": (S.tab === "followups" ? S.fsel : S.sel).clear(); S.draftBody = null; S.confirm = false; S.attachSel = null; return render();
    case "drop-risky": { const dups = dupMap(groups(S.reqs)); [...S.sel].forEach(id => { const x = dups.get(id); if (x?.submitted || x?.replied) S.sel.delete(id); }); return render(); }
    case "send": S.draftBody = $("#reply-body").value; S.confirm = true; return render();
    case "cancel-send": S.confirm = false; return render();
    case "do-send": return bulk("send");
    case "drafts": S.draftBody = $("#reply-body").value; return bulk("draft");
    case "close-progress": S.progress = null; return render();
    case "cancel-tpl": S.editTpl = null; return render();
    case "go-resume": closeModal(); S.tab = "resumes"; return render();
    case "kw-reset": $("#p-titles").value = DEFAULT_ROLE_KEYWORDS; return;
    case "skip-profile": await put({ settings: { ...S.settings, profile: { ...S.settings.profile, done: true } } }); toast("You can fill in your profile any time on the Profile tab."); return;
    case "boards-now": {
      S.boardsBusy = true; render();
      try {
        const s = await loadSettings();
        const a = await scanBoardAlerts(s), d = s.diceSearchOn ? await searchDiceTitles(s, { force: true }) : null;
        const ap = s.diceAlerts ? await scanDiceApplications(s).catch(() => null) : null;
        const hn = s.startupsOn ? await scanStartups(s, { force: true }).catch(e => ({ error: e.message })) : null;
        if (hn) await put({ boardsLast: { ...(await get("boardsLast", {})), hn } });
        await put({ boardsAt: new Date().toISOString() });
        const added = (a?.added || 0) + (d?.added || 0) + (hn?.added || 0), filtered = (a?.filtered || 0) + (d?.filtered || 0) + (hn?.filtered || 0);
        const applied = (ap?.marked || 0) + (ap?.added || 0);
        if (d) await put({ boardsLast: { ...(await get("boardsLast", {})), dice: d } });
        toast((added || filtered ? `${added} new job${added === 1 ? "" : "s"} for you from the job boards${filtered ? `, ${filtered} filtered out` : ""}.` : `No new jobs since the last check. Details are under the Source buttons.`) + (applied ? ` ${applied} Dice application${applied === 1 ? "" : "s"} marked Applied from Dice's emails.` : ""), 8000);
        S.source = "all";
      } catch (err) { S.err = err.message; }
      S.boardsBusy = false; render(); return;
    }
    case "test-gemini": {
      S.gemini = { busy: true }; render();
      const key = $("#s-key")?.value.trim() || S.settings.geminiKey, model = $("#s-model")?.value.trim() || S.settings.geminiModel;
      S.gemini = await testGemini(key, model);
      if (S.gemini.ok && S.gemini.model !== S.settings.geminiModel) await put({ settings: { ...S.settings, geminiKey: key, geminiModel: S.gemini.model } });
      render(); return;
    }
    case "read-all": await put({ notes: S.notes.map(n => ({ ...n, read: true })) }); await updateBadge(); return;
    case "save-tpl": { const body = $("#reply-body").value; S.editTpl = null; S.tab = "templates"; render(); $("#t-body").value = body; $("#t-name").focus(); return; }
    case "signout": await G.signOut(); await chrome.storage.local.remove("account"); S.sel.clear(); toast("Signed out"); return;
    case "reset": S.confirmReset = true; return render();
    case "cancel-reset": S.confirmReset = false; return render();
    case "do-reset": S.confirmReset = false; await chrome.storage.local.remove(["reqs", "activity", "sync", "ignored", "notes", "interviews", "interviewSeen"]); await updateBadge(); toast("Fetched data removed"); return;
  }
});
document.addEventListener("change", async e => {
  const t = e.target;
  if (t.dataset.sel) { t.checked ? S.sel.add(t.dataset.sel) : S.sel.delete(t.dataset.sel); S.confirm = false; render(); return; }
  if (t.dataset.fsel) { t.checked ? S.fsel.add(t.dataset.fsel) : S.fsel.delete(t.dataset.fsel); S.confirm = false; render(); return; }
  if (t.id === "sel-all") { visibleGroups(groups(S.reqs)).filter(g => canSend(g.lead) && (g.status === "new" || g.status === "draft")).forEach(g => t.checked ? S.sel.add(g.lead.id) : S.sel.delete(g.lead.id)); S.confirm = false; render(); return; }
  if (t.id === "fsel-all") { Object.values(S.reqs).filter(r => followUpDue(r, S.settings)).forEach(r => t.checked ? S.fsel.add(r.id) : S.fsel.delete(r.id)); S.confirm = false; render(); return; }
  if (t.id === "tpl-pick") { S.tplId = t.value; S.draftBody = null; S.confirm = false; S.attachSel = null; render(); return; }
  if (t.id === "rb-attach") { S.attachSel = t.value; S.confirm = false; render(); return; }
  if (t.id === "dr-tpl") {
    const r = S.reqs[$("#draft-form").dataset.req], tp = tplById(t.value);
    $("#dr-body").value = fillClean(tp.body, r, { ...S.settings, account: S.account });
    $("#dr-resume").value = tp.attach === "best" ? (bestResume(r)?.r.id || "") : tp.attach && tp.attach !== "none" ? tp.attach : "";
    return;
  }
  if (t.id === "resume-file" && t.files[0]) {
    const file = t.files[0];
    if (file.size > 15 * 1024 * 1024) { toast("That file is over 15 MB. Upload a smaller copy."); return; }
    toast("Reading your resume…", 6000);
    try {
      const { buf, text, kind } = await readResume(file);
      const id = "r" + Date.now().toString(36);
      await idbPut(id, buf); resumeCache.set(id, buf);
      const list = [...S.resumes, { id, name: file.name, kind, text: text.slice(0, 120000), uploadedAt: new Date().toISOString(), isDefault: !S.resumes.length }];
      S.previewResume = id;
      await put({ resumes: list });
      toast("Resume saved");
    } catch (err) { toast("Couldn't read that file. Try a PDF, .docx or .txt."); }
  }
});
document.addEventListener("input", e => {
  if (e.target.id === "q") { S.q = e.target.value; render(); }
  if (e.target.id === "reply-body") S.draftBody = e.target.value;
});
document.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === "verify-form") { const email = emailOf($("#v-email").value); if (!email) { S.verify.msg = "Enter a full email address."; render(); return; } return verify(email); }
  if (f.id === "tpl-form") {
    const name = $("#t-name").value.trim(), body = $("#t-body").value.trim(); if (!name || !body) return;
    const id = S.editTpl?.id || "t" + Date.now().toString(36);
    const list = allTpls().filter(t => t.id !== id); list.push({ id, name, body, attach: $("#t-attach").value });
    await put({ templates: list }); S.editTpl = null; S.tplId = id; toast("Template saved");
  }
  if (f.id === "profile-form") {
    const v = id => $("#" + id).value.trim(), boxes = name => [...f.querySelectorAll(`input[name="${name}"]:checked`)].map(x => x.value);
    const titles = v("p-titles");
    const profile = { ...S.settings.profile, done: true, phone: v("p-phone"), location: v("p-loc"), linkedin: v("p-li"), relocate: $("#p-reloc").value,
      visa: $("#p-visa").value, visaUntil: v("p-visa-until"), company: v("p-co"), title: v("p-title"), availability: v("p-avail"),
      jobTitles: titles, skills: v("p-skills"), empTypes: boxes("p-emp"), workModes: boxes("p-mode"), rate: v("p-rate"), salary: v("p-salary") };
    const first = !S.settings.profile?.done;
    await put({ settings: { ...S.settings, profile, myName: v("p-name"), myYears: Number(v("p-years")) || 0, myLocations: v("p-local"), rateFloor: Number(v("p-floor")) || 0, ...(titles ? { roleKeywords: titles } : {}) } });
    await refilter();
    toast(first ? "Profile saved. Your requirements are sorted to match it." : "Profile saved");
    if (first) { S.tab = "reqs"; history.replaceState(null, "", "#reqs"); }
    return;
  }
  if (f.id === "settings-form") {
    const v = id => $("#" + id).value, c = id => $("#" + id).checked;
    await put({ settings: { ...S.settings,
      excludeClearance: c("s-clear"), excludeCitizenOnly: c("s-cit"), intervalMin: Number(v("s-int")), perFetch: Number(v("s-per")), lookbackDays: Number(v("s-back")),
      notifyNew: c("s-nnew"), notifyReplies: c("s-nrep"), notifyFollowUps: c("s-nfol"), emailAlerts: c("s-mail"), followUpDays: Number(v("s-fdays")), maxFollowUps: Number(v("s-fmax")),
      geminiKey: v("s-key").trim(), geminiModel: v("s-model").trim() || "gemini-2.5-flash",
      profileOnly: c("s-prof"), maxYears: Number(v("s-maxy")), yearsSlack: Number(v("s-slack")), skipSeniorTitles: c("s-senior"),
      diceAlerts: c("s-dalerts"), diceQuery: v("s-dq").trim() || "Software Engineer", diceLocation: v("s-dloc").trim(), dicePosted: Number(v("s-dpost")), diceRemote: c("s-drem"),
      boardsOn: c("s-boards"), startupsOn: c("s-startups"), diceSearchOn: c("s-dsearch"), boardHours: Number(v("s-bhours")), diceSearchEveryHours: Number(v("s-devery")) } });
    await refilter();
    toast("Settings saved");
  }
  if (f.id === "submit-form") {
    const id = f.dataset.req, client = $("#sb-client").value.trim();
    const reqs = await get("reqs", {}); if (reqs[id]) { reqs[id].submittedAt = new Date().toISOString(); reqs[id].submittedClient = client; if (client && !reqs[id].client) reqs[id].client = client; }
    await put({ reqs }); closeModal(); toast("Marked submitted");
  }
  if (f.id === "draft-form") {
    const r = S.reqs[f.dataset.req], rid = $("#dr-resume").value, body = $("#dr-body").value;
    const btn = f.querySelector("[type=submit]"); btn.disabled = true; btn.textContent = "Saving…";
    try {
      await G.getToken(true);
      let attachment = null;
      if (rid) { const meta = S.resumes.find(x => x.id === rid); const bytes = await resumeBytes(rid); if (bytes) attachment = { filename: meta.name, mimeType: mimeOf(meta.kind), data: bytes }; }
      // body is already filled in; pass it through untouched
      await draftReply({ req: r, body, tplName: tplById($("#dr-tpl").value).name, attachment });
      await put({ notes: S.notes.map(n => n.reqId === r.id && n.kind === "reply" ? { ...n, read: true } : n) });
      closeModal(); toast("Draft saved in Gmail. Open it there to review and send.", 4500);
    } catch (err) { btn.disabled = false; btn.textContent = "Save draft in Gmail"; toast(err.message || "Couldn't save the draft."); }
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#modal-root").innerHTML) closeModal(); });
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (TABS.some(t => t[0] === h)) { S.tab = h; render(); } });

// ---------- boot ----------
(async () => {
  await load(); render();
  if (S.account && (!S.sync?.at || Date.now() - Date.parse(S.sync.at) > (Number(S.settings.intervalMin) || 60) * 6e4)) runSync("open");
})();

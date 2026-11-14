// Direct Gmail API calls with the user's own Google sign-in (chrome.identity). No server in between.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";

export class GmailError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function getToken(interactive = false) {
  try {
    const r = await chrome.identity.getAuthToken({ interactive });
    const t = typeof r === "string" ? r : r?.token;
    if (!t) throw new Error("no token");
    return t;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/client id|oauth2|bad client|invalid_client/i.test(msg)) throw new GmailError("setup", "The extension's Google client ID isn't set up yet. Follow SETUP.md step 4, paste the client ID into manifest.json, then reload the extension.");
    throw new GmailError("auth", interactive ? "Google sign-in was cancelled or failed. Try again." : "Sign in again to keep fetching.");
  }
}

export async function signOut() {
  try {
    const t = await getToken(false);
    await chrome.identity.removeCachedAuthToken({ token: t });
    await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST" }).catch(() => {});
  } catch (e) { /* already signed out */ }
}

// ---------- pacing ----------
// Gmail allows each user a fixed number of "quota units" per minute (reading a thread costs 10,
// a message 5, sending 100). This keeps the extension well under that, about 90 units a second.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RATE = 90, BURST = 180;
let tokens = BURST, last = Date.now(), coolUntil = 0;
async function spend(units) {
  for (;;) {
    const now = Date.now();
    if (now < coolUntil) { await sleep(coolUntil - now); continue; }
    tokens = Math.min(BURST, tokens + (now - last) / 1000 * RATE); last = now;
    if (tokens >= units) { tokens -= units; return; }
    await sleep(Math.ceil((units - tokens) / RATE * 1000) + 25);
  }
}
function costOf(path, method) {
  if (path.startsWith("messages/send") || path.startsWith("drafts/send")) return 100;
  if (method === "POST") return 10;
  if (path.startsWith("messages/") || path.startsWith("drafts")) return 5;
  if (path === "profile") return 1;
  return 10;
}
const isRateLimit = (status, m) => status === 429 || (status === 403 && /rate ?limit|quota|too many/i.test(m || ""));

export async function api(path, { method = "GET", body, interactive = false } = {}) {
  let token = await getToken(interactive);
  const cost = costOf(path, method);
  for (let attempt = 0; attempt < 7; attempt++) {
    await spend(cost);
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401 && attempt === 0) {
      await chrome.identity.removeCachedAuthToken({ token });
      token = await getToken(interactive);
      continue;
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    const j = await res.json().catch(() => ({}));
    const m = j?.error?.message || res.statusText;
    // A rate-limited request was not carried out, so waiting and repeating it is safe, sends included.
    if (isRateLimit(res.status, m) && attempt < 6) {
      const after = Number(res.headers.get("Retry-After")) * 1000;
      const wait = after > 0 ? after : Math.min(60000, 4000 * 2 ** attempt) + Math.random() * 1000;
      coolUntil = Math.max(coolUntil, Date.now() + wait); tokens = 0;
      continue;
    }
    if (res.status >= 500 && attempt < 2 && method === "GET") { await sleep(1500 * (attempt + 1)); continue; }
    if (isRateLimit(res.status, m)) throw new GmailError("rate", "Gmail asked the extension to slow down. What was read so far is saved; it picks up from there on the next fetch.");
    if (res.status === 403 && /has not been used|disabled/i.test(m)) throw new GmailError("setup", "The Gmail API isn't enabled in your Google Cloud project. Follow SETUP.md step 2.");
    if (res.status === 403 && /insufficient/i.test(m)) throw new GmailError("auth", "Gmail permissions are missing. Sign out and sign in again, allowing both Gmail permissions.");
    throw new GmailError("http_" + res.status, m || "Gmail request failed");
  }
}

const qs = o => Object.entries(o).flatMap(([k, v]) => v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v.map(x => `${k}=${encodeURIComponent(x)}`) : [`${k}=${encodeURIComponent(v)}`]).join("&");

export const profile = (interactive = false) => api("profile", { interactive });
export const listThreads = (q, pageToken, maxResults = 50) => api("threads?" + qs({ q, pageToken, maxResults }));
export const getThreadMeta = id => api(`threads/${id}?` + qs({ format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date", "Message-ID", "References"] }));
export const getMessage = id => api(`messages/${id}?format=full`);
export const listDrafts = pageToken => api("drafts?" + qs({ maxResults: 100, pageToken }));
export const sendDraft = id => api("drafts/send", { method: "POST", body: { id } });

export const header = (msg, name) => (msg?.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function htmlToText(html) {
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n");
}
export function bodyText(msg) {
  let plain = "", html = "";
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = b64urlDecode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = b64urlDecode(p.body.data);
    (p.parts || []).forEach(walk);
  })(msg?.payload);
  return plain || (html ? htmlToText(html) : msg?.snippet || "");
}

export function bodyHtml(msg) {
  let html = "";
  (function walk(p) { if (!p || html) return; if (p.mimeType === "text/html" && p.body?.data) html = b64urlDecode(p.body.data); (p.parts || []).forEach(walk); })(msg?.payload);
  return html;
}

function encodeHeader(v) { return /^[\x20-\x7e]*$/.test(v) ? v : "=?UTF-8?B?" + bytesB64(new TextEncoder().encode(v)) + "?="; }
function bytesB64(bytes) { let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
// attachments: [{ filename, mimeType, data: ArrayBuffer }]
function buildMime({ to, subject, body, inReplyTo, references, attachments = [] }) {
  const head = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${[references, inReplyTo].filter(Boolean).join(" ")}`] : []),
    "MIME-Version: 1.0"
  ];
  const text = body.replace(/\r?\n/g, "\r\n");
  if (!attachments.length) return b64urlEncode([...head, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", text].join("\r\n"));
  const boundary = "rqi_" + Math.random().toString(36).slice(2);
  const parts = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", text];
  for (const a of attachments) {
    const b64 = bytesB64(new Uint8Array(a.data)).replace(/.{76}/g, "$&\r\n");
    parts.push(`--${boundary}`, `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, "Content-Transfer-Encoding: base64", "", b64);
  }
  parts.push(`--${boundary}--`, "");
  return b64urlEncode(parts.join("\r\n"));
}
const reSubject = s => /^re:/i.test(s) ? s : "Re: " + s;
// Reply in the same thread, to the recruiter only.
export function sendReply({ threadId, to, subject, body, inReplyTo, references, attachments }) {
  return api("messages/send", { method: "POST", body: { threadId, raw: buildMime({ to, subject: reSubject(subject), body, inReplyTo, references, attachments }) } });
}
export function createDraftReply({ threadId, to, subject, body, inReplyTo, references, attachments }) {
  return api("drafts", { method: "POST", body: { message: { threadId, raw: buildMime({ to, subject: reSubject(subject), body, inReplyTo, references, attachments }) } } });
}
// A new email (not a reply) to a recruiter. threadId continues it later.
export function sendNew({ threadId, to, subject, body, attachments }) {
  return api("messages/send", { method: "POST", body: { ...(threadId ? { threadId } : {}), raw: buildMime({ to, subject, body, attachments }) } });
}
export function createDraftNew({ threadId, to, subject, body, attachments }) {
  return api("drafts", { method: "POST", body: { message: { ...(threadId ? { threadId } : {}), raw: buildMime({ to, subject, body, attachments }) } } });
}
// A plain email to yourself (alert summaries).
export function sendToSelf({ to, subject, body }) {
  return api("messages/send", { method: "POST", body: { raw: buildMime({ to, subject, body }) } });
}
export const threadUrl = id => `https://mail.google.com/mail/u/0/#all/${id}`;

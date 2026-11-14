// Jobs from job-board alert emails you already receive (Indeed, ZipRecruiter, Glassdoor, Monster).
// Each alert lists jobs as links: the link text is the job title, and the company and location sit next to it.
// Nothing is fetched from the job boards themselves; you open the job on the site to apply.
import { yearsFrom, rateHourly } from "./extract.js";

export const BOARDS = [
  { site: "Indeed", from: "indeed.com" },
  { site: "ZipRecruiter", from: "ziprecruiter.com" },
  { site: "Glassdoor", from: "glassdoor.com" },
  { site: "Monster", from: "monster.com" },
  // startups
  { site: "Wellfound", from: "wellfound.com", startup: true },
  { site: "Built In", from: "builtin.com", startup: true },
  { site: "RemoteHunter", from: "remotehunter.com", startup: true }
];
export const boardOf = from => BOARDS.find(b => String(from || "").toLowerCase().includes(b.from))?.site || "";

const ROLE = /\b(developers?|engineers?|engineering|architects?|programmers?|analysts?|devops|sre|full[ -]?stack|front[ -]?end|back[ -]?end|software|sde|qa|testers?|scientists?|administrators?|consultants?|specialists?|leads?)\b/i;
const BUTTON = /^(view|apply|1-click apply|quick apply|easy apply|view details|view job|view jobs?.*|see (more|all).*|learn more|here|sign in|create|edit.*|unsubscribe|manage.*|privacy.*|terms.*|help.*|contact.*|this is a bad match|yes|no|pause.*|download.*)$/i;
const LOCATION = /\b([A-Z][A-Za-z.' -]+,\s*[A-Z]{2})\b(?:\s+\d{5})?|\b(remote|hybrid|on-?site)\b/i;
const AGE = /^(\d+)\s*(h|d|hr|hrs|hours?|days?)$/i;
const MONEY = /\$\s?\d/;
const BUTTON_ONLY = /^(learn more|view job|view details|see job|apply now\W*|apply)$/i;
const WORKPLACE = /^(in office|on-?site|remote|hybrid)\s*,\s*(.+)$/i; // Wellfound: "In office, Dallas"
const YEARS = /(\d+)\+?\s*(?:years?|yrs?)\b/i;
const decode = s => s.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/[​‌‍﻿]/g, "");

// The email's HTML as a flat list of text pieces, each marked with the link it sits in (if any).
function pieces(html) {
  const out = []; let href = null, linkNo = 0;
  const body = String(html).replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "");
  for (const m of body.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>|<\/a\s*>|<[^>]+>|[^<]+/gi)) {
    const t = m[0];
    if (m[1] !== undefined) { href = decode(m[1]); linkNo++; continue; }
    if (/^<\/a/i.test(t)) { href = null; continue; }
    if (t[0] === "<") continue;
    const text = decode(t).replace(/\s+/g, " ").trim();
    if (text && text !== "-" && text !== "|" && text !== "•") out.push({ text, href, link: href ? linkNo : 0 });
  }
  return out;
}

// One alert email → jobs. received: when the email arrived (ms).
export function parseAlert(html, site, received = Date.now()) {
  const ps = pieces(html), jobs = [], seen = new Set();
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p.href || BUTTON.test(p.text) || p.text.length < 4 || p.text.length > 140 || !ROLE.test(p.text)) continue;
    // Glassdoor puts company, rating, title, location, salary and age all inside one link; others put details after it.
    const inLink = ps.filter(x => x.link === p.link);
    const after = [];
    for (let k = ps.indexOf(inLink[inLink.length - 1]) + 1; k < ps.length && after.length < 8; k++) { if (ps[k].href && ps[k].link !== p.link) break; after.push(ps[k]); }
    if (inLink.some(x => /^job preferences/i.test(x.text)) || /,\s*$/.test(p.text)) continue; // Built In's "your preferences" box
    const ctx = [...inLink, ...after].map(x => x.text).flatMap(t => t.split(/\s+[•·|]\s+/));
    const title = p.text;
    const isPlace = t => t !== title && t.length < 45 && !/[.!?]\s/.test(t);
    const loc = ctx.find(t => isPlace(t) && /\b[A-Z][A-Za-z.' -]+,\s*[A-Z]{2}\b/.test(t)) || ctx.find(t => isPlace(t) && LOCATION.test(t)) || "";
    const before = ps.slice(Math.max(0, i - 2), i).filter(x => !x.href).map(x => x.text).reverse().find(t => !ROLE.test(t) && !LOCATION.test(t) && !MONEY.test(t) && t.length < 60) || "";
    const company = (inLink.length > 1 ? inLink[0].text : after.map(x => x.text.split(/\s+•\s+/)[0]).find(t => t !== title && !LOCATION.test(t) && !MONEY.test(t) && !AGE.test(t) && !/^(new|be seen first|estimated pay|hiring multiple.*|salary|job type|apply now.*)$/i.test(t))) || before;
    const pay = ctx.find(t => MONEY.test(t) && t.length < 60) || "";
    const ageTxt = ctx.find(t => AGE.test(t)) || "";
    const am = ageTxt.match(AGE);
    const postedAt = am ? received - Number(am[1]) * (/^d/i.test(am[2]) ? 864e5 : 36e5) : received;
    const location = (loc.match(LOCATION)?.[0] || loc).trim();
    const mode = /remote/i.test(ctx.join(" ")) ? "Remote" : /hybrid/i.test(ctx.join(" ")) ? "Hybrid" : /on-?site|in office/i.test(ctx.join(" ")) ? "Onsite" : "";
    const key = (title + "|" + company).toLowerCase();
    if (seen.has(key) || /\b\d+\s*★|^\d\.\d\s*★/.test(title)) continue;
    seen.add(key);
    const years = Number((ctx.find(t => YEARS.test(t) && t.length < 30) || "").match(YEARS)?.[1]) || null;
    jobs.push({ title, company: company.replace(/\s*\d\.\d\s*★.*$/, ""), location, mode, pay, years, postedAt, url: p.href, site });
  }
  return jobs.length ? jobs : parseByButtons(ps, site, received);
}

// Alerts where the title is plain text and each job ends with a "Learn More" / "View job" button (Wellfound).
function parseByButtons(ps, site, received) {
  const jobs = [], seen = new Set(); let start = 0;
  for (let i = 0; i < ps.length; i++) {
    if (!ps[i].href || !BUTTON_ONLY.test(ps[i].text)) continue;
    const block = ps.slice(start, i).filter(x => !x.href).flatMap(x => x.text.split(/\s+[|•·]\s+/)); start = i + 1;
    const ti = block.findIndex(t => ROLE.test(t) && t.length <= 140 && !/^(our take|hi\b)/i.test(t));
    if (ti < 0) continue;
    const rest = block.slice(ti + 1, ti + 9);
    const title = block[ti], company = (rest[0] || "").split(/\s+\/\s+/)[0];
    const wp = rest.map(t => t.match(WORKPLACE)).find(Boolean);
    const location = wp ? wp[2] : (rest.find(t => LOCATION.test(t) && t.length < 45 && !/[.!?]\s/.test(t)) || "");
    const mode = wp ? (/remote/i.test(wp[1]) ? "Remote" : /hybrid/i.test(wp[1]) ? "Hybrid" : "Onsite") : "";
    const pay = rest.find(t => MONEY.test(t)) || "";
    const years = Number((rest.find(t => YEARS.test(t)) || "").match(YEARS)?.[1]) || null;
    const key = (title + "|" + company).toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    jobs.push({ title, company, location, mode, pay, years, postedAt: received, url: ps[i].href, site });
  }
  return jobs;
}

const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };

// A board job as a dashboard row. You apply on the site.
export function toRequirement(j) {
  return {
    id: "job:" + j.site.toLowerCase() + ":" + hash((j.title + "|" + j.company + "|" + j.location).toLowerCase()),
    source: "board", site: j.site, startup: !!BOARDS.find(b => b.site === j.site)?.startup, role: j.title, subject: j.title, vendor: j.company || j.site, client: "",
    location: j.location, mode: j.mode, type: "", terms: "", rate: j.pay, rateHourly: rateHourly(j.pay),
    experienceYears: j.years ?? yearsFrom(j.title), visa: "", visaFit: "unknown", clearance: /clearance|ts\/sci|secret/i.test(j.title),
    must: [], nice: [], from: "", recruiterName: "", url: j.url,
    received: new Date(j.postedAt).toISOString(), snippet: [j.company, j.location, j.pay].filter(Boolean).join(" · "),
    body: "", status: "new", fetchedAt: new Date().toISOString(), extractedBy: "rules"
  };
}

import { contactFrom } from "./contacts.js";
// Dice jobs: job ids come from Dice alert emails (in Gmail) and from Dice pages you browse.
// Each job page is read for its details. Nothing is ever submitted to Dice for you.
import { extract, rateHourly, yearsFrom } from "./extract.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const jobUrl = id => `https://www.dice.com/job-detail/${id}`;

// Every Dice job id in some HTML (direct links, or links wrapped by email click tracking).
export function idsFromHtml(html) {
  const out = new Map();
  const text = String(html || "");
  const decoded = text.replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  const re = new RegExp(`dice\\.com/job-detail/(${UUID})`, "gi");
  for (const m of decoded.matchAll(re)) out.set(m[1].toLowerCase(), "");
  // titles from anchors that point straight at a job
  const aRe = new RegExp(`<a[^>]+href="[^"]*job-detail(?:/|%2F)(${UUID})[^"]*"[^>]*>([\\s\\S]{1,300}?)</a>`, "gi");
  for (const m of text.matchAll(aRe)) {
    const t = m[2].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (t && t.length > 3 && !/^(apply|view|see|details?|easy apply)/i.test(t)) out.set(m[1].toLowerCase(), t);
  }
  return [...out.entries()].map(([id, title]) => ({ id, title }));
}

const decodeEntities = s => String(s || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
export function htmlToText(html) {
  return decodeEntities(String(html || "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d|ul|ol)>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
function meta(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i")) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, "i"));
  return m ? decodeEntities(m[1]) : "";
}
function jobPostingFrom(html) {
  for (const m of String(html).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const list = [j].flat().flatMap(x => x && x["@graph"] ? x["@graph"] : [x]);
    const jp = list.find(x => x && (x["@type"] === "JobPosting" || [].concat(x["@type"] || []).includes("JobPosting")));
    if (jp) return jp;
  }
  return null;
}

// Details of one job from its page HTML. Works from the JobPosting data Dice publishes for search engines,
// falling back to the page's title and description tags.
export function parseJobPage(html, id, hint = {}) {
  const jp = jobPostingFrom(html);
  if (jp) {
    const locs = [].concat(jp.jobLocation || []).map(l => l?.address).filter(Boolean).map(a => [a.addressLocality, a.addressRegion].filter(Boolean).join(", "));
    const remote = /TELECOMMUTE/i.test(jp.jobLocationType || "") || /remote/i.test(locs.join(" "));
    const sal = jp.baseSalary?.value || jp.baseSalary || {};
    const unit = String(sal.unitText || jp.baseSalary?.unitText || "").toLowerCase();
    const lo = sal.minValue ?? sal.value, hi = sal.maxValue;
    const salary = lo ? `$${lo}${hi && hi !== lo ? "–$" + hi : ""}${unit === "hour" ? "/hr" : unit === "year" ? "/yr" : ""}` : "";
    const months = jp.experienceRequirements?.monthsOfExperience;
    return {
      id, url: jobUrl(id), title: decodeEntities(jp.title || hint.title || ""),
      company: decodeEntities(jp.hiringOrganization?.name || hint.company || ""),
      location: [...new Set(locs)].join(" / ") || hint.location || (remote ? "Remote" : ""),
      mode: remote ? "Remote" : "", type: [].concat(jp.employmentType || []).join(", ").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
      posted: jp.datePosted || "", salary, description: htmlToText(jp.description || "").slice(0, 9000),
      years: months ? Math.round(months / 12) : null, skills: [].concat(jp.skills || []).join(", "),
      contact: contactFrom(htmlToText(jp.description || ""), html.match(/<main[\s\S]*<\/main>/i)?.[0] || "")
    };
  }
  const ogTitle = meta(html, "og:title") || (html.match(/<title>([^<]*)<\/title>/i)?.[1] || "");
  const desc = meta(html, "og:description") || meta(html, "description");
  if (!ogTitle && !hint.title) return null;
  return { id, url: jobUrl(id), title: decodeEntities(hint.title || ogTitle.replace(/\s*\|\s*Dice\.com.*$/i, "").split(" - ")[0]), company: hint.company || "", location: hint.location || "", mode: "", type: "", posted: "", salary: "", description: htmlToText(hint.text || desc || ""), years: null, skills: "" };
}

// A Dice job as a dashboard requirement.
export function toRequirement(job) {
  const body = [job.description, job.skills ? "Skills: " + job.skills : ""].filter(Boolean).join("\n");
  const contact = job.contact || contactFrom(body);
  const ex = extract(job.title, contact.email, body);
  const years = job.years ?? yearsFrom(body);
  return {
    ...ex,
    id: "dice:" + job.id, source: "dice", diceId: job.id,
    subject: job.title, from: contact.email, recruiterEmail: contact.email, recruiterPhone: contact.phone, role: job.title || ex.role, vendor: job.company || "Dice", client: ex.client,
    location: job.location || ex.location, mode: job.mode || ex.mode, type: job.type || ex.type,
    rate: job.salary || ex.rate, rateHourly: rateHourly(job.salary || ex.rate), experienceYears: years,
    recruiterName: contact.email ? ex.recruiterName : "", received: job.posted ? new Date(job.posted).toISOString() : new Date().toISOString(),
    url: job.url, snippet: (job.description || "").slice(0, 200), body: body.slice(0, 8000),
    status: "new", fetchedAt: new Date().toISOString(), extractedBy: "rules"
  };
}

export async function fetchJob(id, hint) {
  const res = await fetch(jobUrl(id), { credentials: "include" });
  if (!res.ok) throw new Error("Dice page " + res.status);
  return parseJobPage(await res.text(), id, hint);
}

// Dice search link built from Settings.
export function searchUrl(s) {
  const p = new URLSearchParams({ q: s.diceQuery || "Software Engineer", countryCode: "US", radius: "30", radiusUnit: "mi", page: "1", pageSize: "20", language: "en" });
  if (s.diceLocation) p.set("location", s.diceLocation);
  const posted = { 1: "ONE", 3: "THREE", 7: "SEVEN" }[Number(s.dicePosted)];
  if (posted) p.set("filters.postedDate", posted);
  if (s.diceRemote) p.set("filters.workplaceTypes", "Remote");
  return "https://www.dice.com/jobs?" + p.toString();
}

// Dice's "Application for <title> [in <place>] at <company> sent" confirmation emails.
export function parseApplyConfirm(subject) {
  const m = String(subject || "").match(/^Application for (.+) at (.+?) sent\s*$/i);
  if (!m) return null;
  let title = m[1].trim(), location = "";
  const loc = title.match(/^(.+?)\s+in\s+([A-Z][A-Za-z .'-]+,?\s+[A-Z]{2})$/);
  if (loc) { title = loc[1].trim(); location = loc[2].replace(/\s+([A-Z]{2})$/, ", $1").replace(/,,/, ","); }
  const dash = !loc && title.match(/^(.+?)\s*[-–]\s*([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})$/);
  if (dash) { title = dash[1].trim(); location = dash[2]; }
  return { title, location, company: m[2].trim() };
}
// "Hexaware Technologies, Inc" and "Hexaware Technologies Inc." are the same company.
export const companyKey = c => String(c || "").toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|llc|ltd|corp|corporation|co|company|limited|technologies|technology|solutions|services|group|america|usa|us)\b/g, " ").replace(/\s+/g, " ").trim();

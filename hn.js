// Startup jobs from Hacker News' monthly "Ask HN: Who is hiring?" thread, through HN's free public search API.
// Each top-level comment is one company's post, usually starting "Company | Role | Location | Remote | …".
import { extract, yearsFrom, rateHourly } from "./extract.js";
import { contactFrom } from "./contacts.js";

const API = "https://hn.algolia.com/api/v1/";
const ROLE = /\b(developers?|engineers?|engineering|architects?|programmers?|devops|sre|full[ -]?stack|front[ -]?end|back[ -]?end|software|sde|founding)\b/i;

const htmlToText = h => String(h || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<a [^>]*href="([^"]+)"[^>]*>[^<]*<\/a>/gi, "$1").replace(/<[^>]+>/g, "")
  .replace(/&#x2F;/g, "/").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Hacker News search " + res.status);
  return res.json();
}

// The current month's "Who is hiring?" thread.
export async function latestThread() {
  const j = await getJson(API + "search_by_date?tags=story,author_whoishiring&hitsPerPage=10");
  const hit = (j.hits || []).find(h => /who is hiring/i.test(h.title || ""));
  return hit ? { id: hit.objectID, title: hit.title, at: hit.created_at_i } : null;
}

// One post → a job. Returns null for posts that aren't job ads.
export function parsePost(hit) {
  const text = htmlToText(hit.comment_text).trim();
  if (text.length < 60) return null;
  const first = text.split("\n")[0];
  const parts = first.split(/\s+\|\s+|\s+\|\||\s+–\s+|\s+—\s+/).map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const company = parts[0].replace(/\s*\(.*?\)\s*$/, "").slice(0, 60);
  const role = parts.slice(1).find(p => ROLE.test(p) && p.length < 120) || (ROLE.test(first) ? first.slice(0, 100) : "");
  if (!role) return null;
  const location = parts.slice(1).find(p => p !== role && /\b(remote|onsite|on-site|hybrid|[A-Z][a-z]+,\s*[A-Z]{2}\b|NYC|SF|San Francisco|New York|Bay Area|USA|US\b|United States|London|Berlin|Toronto|Austin|Seattle|Boston|Dallas|Chicago|Denver|Los Angeles)/i.test(p)) || "";
  const pay = parts.find(p => /\$\s?\d|\d+k\b/i.test(p)) || "";
  const { email, phone } = contactFrom(text);
  const ex = extract(role, email, text);
  return {
    ...ex,
    id: "hn:" + hit.objectID, source: "board", site: "Hacker News", startup: true,
    role, subject: role, vendor: company, client: "", location, mode: /remote/i.test(first) ? "Remote" : /hybrid/i.test(first) ? "Hybrid" : /onsite|on-site/i.test(first) ? "Onsite" : "",
    rate: pay, rateHourly: rateHourly(pay), experienceYears: yearsFrom(text),
    from: email, recruiterEmail: email, recruiterPhone: phone, recruiterName: email ? ex.recruiterName : "",
    url: "https://news.ycombinator.com/item?id=" + hit.objectID,
    received: new Date((hit.created_at_i || Date.now() / 1000) * 1000).toISOString(),
    snippet: text.slice(0, 200), body: text.slice(0, 8000), status: "new", fetchedAt: new Date().toISOString(), extractedBy: "rules"
  };
}

// Posts in the current thread from the last `hours`.
export async function recentPosts(hours) {
  const t = await latestThread();
  if (!t) return { thread: null, posts: [] };
  const since = Math.floor(Date.now() / 1000 - hours * 3600);
  const j = await getJson(API + `search_by_date?tags=comment,story_${t.id}&numericFilters=created_at_i>${since}&hitsPerPage=500`);
  const top = (j.hits || []).filter(h => String(h.parent_id) === String(t.id)); // replies to posts are skipped
  return { thread: t, posts: top.map(parsePost).filter(Boolean) };
}

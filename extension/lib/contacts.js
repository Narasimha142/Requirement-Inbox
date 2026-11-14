// Recruiter contact details written inside a job posting (Dice descriptions, Hacker News posts…).
const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SKIP = /@(dice|dhigroupinc|linkedin|indeed|glassdoor|example|email|domain|company|ycombinator)\.|^(no-?reply|donotreply|privacy|accommodations?|ada|eeo|legal|security|abuse|unsubscribe|support|help)@/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b(?:\s*(?:x|ext\.?)\s*\d{1,5})?/;

// "jane [at] acme [dot] com" → jane@acme.com
const unobfuscate = t => String(t || "").replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");

export function contactFrom(text, html = "") {
  const t = unobfuscate(text) + "\n" + [...String(html).matchAll(/mailto:([^"'?>\s]+)/gi)].map(m => decodeURIComponent(m[1])).join("\n");
  const all = [...t.matchAll(EMAIL)].map(m => ({ e: m[0].replace(/\.+$/, "").toLowerCase(), i: m.index })).filter(x => !SKIP.test(x.e));
  // prefer an address right after "email / contact / reach / send / share your resume"
  const near = all.find(x => /(e-?mail|contact|reach|send|share|resume|cv|apply|write)[^\n]{0,60}$/i.test(t.slice(Math.max(0, x.i - 80), x.i)));
  const email = (near || all[0])?.e || "";
  const pm = t.match(PHONE);
  const phone = pm ? `(${pm[1]}) ${pm[2]}-${pm[3]}` : "";
  return { email, phone };
}

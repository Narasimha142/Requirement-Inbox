// Optional: cleaner details from messy emails using the user's own free Google Gemini API key.
// Called only when a key is saved in Settings. Falls back to the free rules on any error.

// Models to try, in order, when the chosen one isn't available to this key. Gemini 2.5 models are only offered to
// Google projects that used them before; new projects get the newer models.
export const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"];
const API = "https://generativelanguage.googleapis.com/v1beta/models/";
let workingModel = null;

async function generate(key, model, prompt, json = true) {
  const res = await fetch(API + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { ...(json ? { responseMimeType: "application/json" } : {}), temperature: 0 } })
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j?.error?.message || `Gemini error ${res.status}`);
    err.status = res.status; throw err;
  }
  const j = await res.json();
  return j?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
}
// Calls Gemini with the chosen model, switching to a newer model if Google says that one isn't available.
async function generateWithFallback(key, model, prompt, json) {
  const order = [...new Set([workingModel, model, ...FALLBACK_MODELS].filter(Boolean))];
  let last;
  for (const m of order) {
    try { const text = await generate(key, m, prompt, json); workingModel = m; return { text, model: m }; }
    catch (e) { last = e; if (e.status !== 404 && !/not found|no longer available|not supported/i.test(e.message)) throw e; }
  }
  throw last;
}

// "Test key" in Settings: one tiny request. Returns { ok, model, message }.
export async function testGemini(key, model) {
  if (!key) return { ok: false, message: "No key entered." };
  try {
    const { text, model: used } = await generateWithFallback(key, model, 'Reply with JSON only: {"ok": true}', true);
    const ok = /"ok"\s*:\s*true/.test(text);
    return { ok, model: used, message: ok ? (used === model ? `Working with ${used}.` : `${model} isn't available to this key, so ${used} will be used. It works.`) : "Gemini answered, but not as expected." };
  } catch (e) {
    const m = e.status === 400 && /api key/i.test(e.message) ? "Google says this key isn't valid. Copy it again from Google AI Studio."
      : e.status === 403 ? "This key isn't allowed to use the Gemini API. In Google AI Studio, create a new key."
      : e.status === 429 ? "The key works, but its free quota is used up for now. Try again later."
      : e.message;
    return { ok: false, message: m };
  }
}

export async function extractWithGemini(items, { key, model = FALLBACK_MODELS[0], years = 5, visa = "" } = {}) {
  if (!key || !items.length) return {};
  const who = visa ? `a candidate on ${visa}` : "a candidate";
  const prompt = `Extract job requirement details from recruiter emails for ${who} with ${years} years of experience.
Return JSON only: {"items":[{"id","role","vendor","client","location","mode","type","terms","rate","experienceYears","visa","visaFit","clearance","recruiterName","must","nice"}]}
- role: job title only. vendor: the staffing company. client: the end client or implementation partner (e.g. "TCS", "Walmart"), "" if not named.
- mode: "Onsite" | "Hybrid" | "Remote" | "". type: "Full-time" | "Contract" | "Contract to hire" | "". terms: "W2 only" | "C2C" | "".
- rate: as written or "". experienceYears: minimum years required as a number, or null.
- visa: short quote of the visa or work authorization rule, or "".
- visaFit: "ok" if ${visa || "the candidate's visa"} or all visas are accepted; "no" if only US citizens and/or green card holders are accepted or the candidate's visa is explicitly excluded; "check" if visa terms are mentioned but don't address it; "unknown" if nothing is said. Ignore "opt-out" unsubscribe text.
- clearance: true if a security clearance, public trust or polygraph is required, else false.
- recruiterName: first name of the person who signed, or "". must: up to 14 short required skill names. nice: up to 10 preferred skills.

Emails:
${JSON.stringify(items.map(i => ({ id: i.id, subject: i.subject, from: i.from, body: String(i.body || "").slice(0, 3500) })))}`;
  const { text } = await generateWithFallback(key, model, prompt, true);
  let out; try { out = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()); } catch (e) { return {}; }
  const map = {}; (out.items || []).forEach(x => { if (x?.id) map[x.id] = x; });
  return map;
}

export function mergeAi(rule, ai) {
  if (!ai) return { ...rule, extractedBy: "rules" };
  const pick = (a, b) => (a !== undefined && a !== null && a !== "" && !(Array.isArray(a) && !a.length)) ? a : b;
  const arr = (v, n) => Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, n) : [];
  return {
    ...rule,
    role: pick(ai.role, rule.role), vendor: pick(ai.vendor, rule.vendor), client: pick(ai.client, rule.client),
    location: pick(ai.location, rule.location), mode: pick(ai.mode, rule.mode), type: pick(ai.type, rule.type),
    terms: pick(ai.terms, rule.terms), rate: pick(ai.rate, rule.rate),
    experienceYears: typeof ai.experienceYears === "number" ? ai.experienceYears : rule.experienceYears,
    visa: pick(ai.visa, rule.visa),
    // never let the AI loosen a rule-based "not eligible"
    visaFit: rule.visaFit === "no" ? "no" : (["ok", "check", "no", "unknown"].includes(ai.visaFit) ? ai.visaFit : rule.visaFit),
    clearance: rule.clearance || ai.clearance === true,
    recruiterName: pick(ai.recruiterName, rule.recruiterName),
    must: pick(arr(ai.must, 16), rule.must), nice: pick(arr(ai.nice, 12), rule.nice),
    extractedBy: "gemini"
  };
}

// Free, offline rules that decide which emails are job requirements and pull out their details.
// No AI service is called.

export const MY_YEARS_DEFAULT = 5;

export const BOARD_DOMAINS = ["linkedin.com","ziprecruiter.com","glassdoor.com","indeed.com","monster.com","dice.com","efinancialcareers.com","wellfound.com","remotehunter.com","hireft.com","jobs2web.com","o2ten.com","substack.com","udemy.com","builtin.com","naukri.com","roberthalf.com","randstadusa.com","experis.com","mailsuite.com","kodekloud.com","torc.dev","outlier.ai","startups.gallery","fidelity.com","deeplearning.ai","resumeworded.com","postjobfree.com","parakeet-ai.com","sofi.com","amigoscode.com","google.com","jobright.ai","simplify.jobs","handshake.com","careerbuilder.com","talent.com","jooble.org"];
const BULK_LOCAL = /^(no-?reply|noreply|donotreply|notifications?|alerts?|jobalerts?|newsletters?|digest|updates?|team|hello|support|careers|community|info|marketing|news|mail|messages?|invitations?|jobs)([-_.+].*)?$/i;

export const SKILLS = ["Java","Spring Boot","Spring","Microservices","REST","SOAP","Kafka","RabbitMQ","AWS","Azure","GCP","Docker","Kubernetes","OpenShift","PCF","Terraform","Ansible","Jenkins","CI/CD","Git","React","Angular","Vue","TypeScript","JavaScript","Node.js","Express","Next.js","Redux","HTML","CSS","Python","Django","Flask","FastAPI","Golang","SQL","PostgreSQL","MySQL","Oracle","SQL Server","MongoDB","Redis","Cassandra","DynamoDB","Cosmos DB","Cloud Spanner","GraphQL","gRPC","Hibernate","JPA","JUnit","Mockito","Jest","Playwright","Selenium","Cypress","LLM","RAG","GenAI","LangChain","LangGraph","OpenAI","GitHub Copilot","Claude Code","Agentic AI","Machine Learning","Linux","Bash","PowerShell","ServiceNow","SharePoint","SPFx","Power BI","Snowflake","Spark","Airflow","Apigee","Lambda","Datadog","Prometheus","Grafana","Splunk","OAuth","JWT","C#",".NET","C++","Rust","Kotlin","Elasticsearch","Agile"];
export const ALIAS = { "spring boot": ["springboot","spring-boot"], "react": ["reactjs","react.js"], "node.js": ["nodejs","node js"], "javascript": ["es6","ecmascript"], "kubernetes": ["k8s","eks","aks","gke"], "gcp": ["google cloud"], "aws": ["amazon web services"], "ci/cd": ["cicd","ci-cd","continuous integration"], "rest": ["restful","rest api","rest apis"], "microservices": ["microservice","micro services"], "postgresql": ["postgres"], "llm": ["llms","large language model","large language models"], "rag": ["retrieval-augmented","retrieval augmented"], "genai": ["generative ai","gen ai"], "angular": ["angularjs"], "golang": ["go lang"], "agentic ai": ["ai agents","agentic"], "github copilot": ["copilot"], "machine learning": ["ml"], "c#": ["csharp"], ".net": ["dotnet"], "sql server": ["mssql"] };

const reCache = new Map();
export function wordRe(term) {
  const k = term.toLowerCase();
  if (!reCache.has(k)) reCache.set(k, new RegExp("(^|[^a-z0-9+#.])" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9+#])", "i"));
  return reCache.get(k);
}
export const variants = skill => [skill, ...(ALIAS[skill.toLowerCase()] || [])];
export const textHas = (text, skill) => !!text && variants(skill).some(v => wordRe(v).test(text));

export const emailOf = s => { const m = String(s || "").match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); return m ? m[0].toLowerCase() : ""; };
export const domainOf = e => (e.split("@")[1] || "").toLowerCase();
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "";

const ROLE_RE = /\b(developers?|engineers?|architects?|analysts?|lead|devops|sre|administrators?|admin|consultants?|programmers?|testers?|qa|scientists?|specialists?|fsd|full[ -]?stack|java|python|react|angular|\.net|servicenow|salesforce|sharepoint|data)\b/i;
const JOB_RE = /(hiring|opening|position|requirement|\brole\b|\bjob\b|opportunit|urgent|immediate|full[ -]?time|fulltime|contract|c2c|\bw2\b|c2h|cth|onsite|on-site|hybrid|remote|interview|::|\|\||\|)/i;
const JD_SNIPPET = /(job description|job title|position\s*:|role\s*:|location\s*:|mandatory skills|must have|requirement)/i;

export function isBulkSender(email) {
  const d = domainOf(email), local = email.split("@")[0] || "";
  return BOARD_DOMAINS.some(b => d === b || d.endsWith("." + b)) || BULK_LOCAL.test(local);
}
// Subjects that are marketing, job-board digests or social notifications, not a recruiter's requirement.
const JUNK_SUBJECT = /(job alerts?|jobs? for you|new jobs|jobs? (?:matched|picked|recommended)|\b\d+\+?\s*(?:new\s+)?(?:jobs|roles|openings|positions)\b|and \d+ more jobs|newsletter|webinar|\bcourse\b|bootcamp|\bsale\b|% off|discount|free credits?|upvote|trending|digest|weekly|tips\b|may want to hire you|waiting for your response|invitations?\b|reacted to|messaged you|is hiring\.?$|apply now\.?$|complete your (?:profile|setup)|unlock|career advice|resume (?:tips|review)|salary guide)/i;
export function junkReason(subject, sender, snippet) {
  if (!subject) return "No subject";
  if (isBulkSender(sender)) return "Job board or bulk sender";
  if (JUNK_SUBJECT.test(subject)) return "Newsletter or job alert";
  if (!ROLE_RE.test(subject)) return "No job title in subject";
  // a role plus a job word, a "City, ST" location, or job-description words in the preview
  if (!(JOB_RE.test(subject) || /[A-Za-z],\s*[A-Z]{2}\b/.test(subject) || JD_SNIPPET.test(snippet || ""))) return "Doesn't look like a requirement";
  return "";
}
export function looksLikeRequirement(subject, sender, snippet) { return !junkReason(subject, sender, snippet); }

export const CLEARANCE_RE = /\b(security clearance|secret clearance|top[- ]secret|ts\/sci|ts-sci|public trust|active (?:secret|clearance)|clearance (?:is )?required|must (?:have|hold|possess|obtain) (?:an? )?(?:active |current )?(?:dod |secret |security |government )?clearance|dod clearance|polygraph|clearable|ability to obtain (?:a )?(?:security )?clearance)\b/i;
export const needsClearance = text => CLEARANCE_RE.test(text || "");

// Names that only ever mean a company (tech names like Oracle, Google or Microsoft also mean products, so they are left out).
const KNOWN_CLIENTS = ["TCS","Tata Consultancy","Infosys","Wipro","HCL","Cognizant","Accenture","Capgemini","Tech Mahindra","LTIMindtree","Deloitte","Genpact","Mphasis","Walmart","Bank of America","Wells Fargo","JPMorgan","JP Morgan","JPMorgan Chase","Citibank","Capital One","Charles Schwab","Goldman Sachs","Morgan Stanley","American Express","Verizon","AT&T","T-Mobile","Comcast","State Farm","USAA","Humana","UnitedHealth","Optum","CVS Health","Aetna","Cigna","Toyota","Truist","PNC","US Bank","Mastercard","PayPal","Home Depot","Kroger","FedEx","American Airlines","Southwest Airlines","Fidelity Investments","Nationwide","Allstate","Liberty Mutual","Prudential","MetLife","Travelers","Anthem","Elevance","Kaiser"];
export function clientFrom(subject, body) {
  const b = (body || "").slice(0, 4000);
  const m = b.match(/\|\s*(?:end\s*)?client\s*\|\s*([^|\n]{2,40})\|/i) || b.match(/(?:^|\n)[^\n]{0,10}\b(?:end\s*)?client(?:\s*name)?\s*\**\s*[:\-–]+\s*\**([A-Za-z][^\n|,(*]{1,40})/i);
  if (m) { const c = m[1].trim().replace(/[.\s]+$/, ""); if (!/^(financial services|confidential|direct|our client|healthcare|banking|retail|tbd|n\/a)$/i.test(c)) return c; }
  const hay = subject + "\n" + b.slice(0, 1500);
  const k = KNOWN_CLIENTS.find(c => new RegExp("(^|[^A-Za-z])" + c.replace(/[.*+?^${}()|[\]\\&']/g, "\\$&") + "(?![A-Za-z])").test(hay));
  return k || "";
}

// Hourly rate from text like "$45/hr", "98-100/hr", "$110k-$130k", "$255k/yr"; annual pay is divided by 2080 hours.
export function rateHourly(rate) {
  const s = String(rate || "");
  const m = s.match(/\$?\s?(\d{2,3}(?:[,.]\d{3})?|\d{4,6})\s*(k\b)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  const yearly = !!m[2] || n >= 1000 || /yr|year|annum|salary|per year|a year/i.test(s);
  if (m[2]) n *= 1000;
  if (yearly) n = n / 2080;
  return n >= 10 && n <= 400 ? Math.round(n) : null;
}

// Interview invites (not job descriptions that merely mention an interview round).
const INVITE_RE = /(interview (?:is )?(?:scheduled|confirmed|invitation|invite|request)|invit(?:e|ation)[^\n]{0,30}interview|schedul(?:e|ing) (?:an?|your|the) (?:\w+ )?interview|availability for (?:an?|the|your) (?:\w+ )?interview|interview (?:slot|time|availability)|^invitation:|calendar invite|meeting invite|teams meeting|zoom meeting|google meet)/i;
export function isInterviewInvite(subject, snippet, from) {
  const text = `${subject}\n${snippet || ""}`;
  if (/calendar-notification@google\.com/i.test(from || "") && /interview|screen|round|discussion|call/i.test(subject)) return true;
  return INVITE_RE.test(text) && !/job description|must have|mandatory skills|requirement/i.test(snippet || "");
}
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const TZ = { cst: "America/Chicago", cdt: "America/Chicago", ct: "America/Chicago", est: "America/New_York", edt: "America/New_York", et: "America/New_York", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pt: "America/Los_Angeles", mst: "America/Denver", mdt: "America/Denver", ist: "Asia/Kolkata" };
// Best-effort date and time from an invite. Returns {y,m,d,h,min,tz} with local wall-clock numbers, or null.
export function parseWhen(text, ref = new Date()) {
  const t = String(text || "");
  let y = ref.getFullYear(), mo = null, d = null;
  let m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  if (m) { mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); d = Number(m[2]); if (m[3]) y = Number(m[3]); }
  else if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) { mo = Number(m[1]) - 1; d = Number(m[2]); if (m[3]) y = Number(m[3].length === 2 ? "20" + m[3] : m[3]); }
  else if ((m = t.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i)) || /\btomorrow\b/i.test(t)) {
    const days = ["sun","mon","tue","wed","thu","fri","sat"]; const base = new Date(ref);
    const target = m ? days.indexOf(m[1].slice(0, 3).toLowerCase()) : (base.getDay() + 1) % 7;
    let add = (target - base.getDay() + 7) % 7; if (add === 0) add = 7;
    base.setDate(base.getDate() + add); y = base.getFullYear(); mo = base.getMonth(); d = base.getDate();
  }
  if (mo === null || mo < 0 || !d) return null;
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || t.match(/\b(\d{1,2}):(\d{2})\b/);
  let h = null, min = 0;
  if (tm) { h = Number(tm[1]); min = Number(tm[2] || 0); if (tm[3]) { const pm = /pm/i.test(tm[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; } }
  const z = t.match(/\b(cst|cdt|ct|est|edt|et|pst|pdt|pt|mst|mdt|ist)\b/i);
  return { y, m: mo, d, h, min, tz: z ? TZ[z[1].toLowerCase()] : "" };
}

// Rough "same job" test used to spot one role sent by several vendors.
const STOP = new Set(["sr","senior","jr","junior","lead","ii","iii","i","iv","with","and","the","of","for","a","an","role","position","hybrid","onsite","remote","on-site","contract","fulltime","full","time","w2","c2c","only","urgent","hiring","opening","requirement","job","immediate","need","needed"]);
export function roleTokens(role) {
  return new Set(String(role || "").toLowerCase().replace(/engineer/g, "developer").replace(/fsd/g, "full stack developer").replace(/[^a-z0-9+#. ]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w)));
}
export function roleSimilarity(a, b) {
  const A = roleTokens(a), B = roleTokens(b); if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(x => B.has(x) && inter++);
  return inter / (A.size + B.size - inter);
}
const firstCity = loc => String(loc || "").toLowerCase().split(/[,/(|]| or /)[0].trim();
export function sameJob(a, b) {
  if (!a || !b || a.id === b.id || (a.from && a.from === b.from)) return false;
  const sim = roleSimilarity(a.role, b.role);
  if (a.client && b.client) return a.client.toLowerCase() === b.client.toLowerCase() && sim >= 0.5;
  return sim >= 0.75 && !!firstCity(a.location) && firstCity(a.location) === firstCity(b.location);
}

export function parseSubject(subject) {
  const parts = subject.split(/\s*(?:::|:<>|\|\||\||—|–|\s-\s)\s*/).map(p => p.replace(/^[\s:*-]+|[\s:*-]+$/g, "")).filter(Boolean);
  const out = {};
  const junk = /^(urgent|immediate|hiring|job opening|opening|position|new requirement|requirement|job|role|direct client|need|looking for|fulltime position for|full time position for|job title)$/i;
  for (const p of parts) {
    const clean = p.replace(/^(urgent( job opening| hiring| opening| role for)?|immediate( hiring| interview)?|hiring( for)?|job opening|full ?time (position|opening)( for)?|fulltime position( for)?|position on|job|role|job title)\s*[:\-]*\s*/i, "").trim();
    if (!clean || junk.test(clean)) continue;
    if (!out.location && /(,\s*[A-Z]{2}\b|\bremote\b|\bonsite\b|\bhybrid\b|\bon-site\b)/i.test(clean) && !ROLE_RE.test(clean.replace(/\(.*?\)/g, ""))) { out.location = clean; continue; }
    if (!out.type && /^(full[ -]?time|fulltime|contract|c2c|w2|c2h|cth|long[ -]term contract|contract to hire|permanent)([\s/,&-]+(full[ -]?time|contract|c2c|w2|c2h|only))*$/i.test(clean)) { out.type = clean; continue; }
    if (!out.role && ROLE_RE.test(clean)) { out.role = clean.replace(/\s+(in|at)\s+[A-Z][\w .]+,\s*[A-Z]{2}.*$/, "").trim(); continue; }
    if (!out.location && /,\s*[A-Z]{2}\b/.test(clean)) out.location = clean;
  }
  if (!out.role) out.role = subject.replace(/^(re|fw|fwd):\s*/i, "").slice(0, 90);
  return out;
}

function section(body, startRe, stopRe, len) {
  const m = body.search(startRe); if (m < 0) return "";
  let chunk = body.slice(m, m + len);
  const stop = chunk.slice(20).search(stopRe);
  if (stop > 0) chunk = chunk.slice(0, stop + 20);
  return chunk;
}
export const scanSkills = text => {
  const found = SKILLS.filter(s => textHas(text, s));
  return found.filter(s => !(s === "Spring" && found.includes("Spring Boot")) && !(s === "JavaScript" && found.includes("TypeScript") && !/javascript/i.test(text)));
};
function line(body, re) { const m = body.match(re); return m ? m[1].replace(/[*_]/g, "").trim().slice(0, 140) : ""; }

// The overall years asked: the largest "N+ years" in the text (a range like 5-8 counts as 5).
export function yearsFrom(text) {
  const all = [...String(text || "").matchAll(/(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years|yrs)/gi)].map(m => Number(m[1])).filter(n => n > 0 && n <= 20);
  return all.length ? Math.max(...all) : null;
}

// Does this role fit the profile in Settings? Returns a reason when it doesn't, "" when it does.
export const OLD_ROLE_KEYWORDS = "software engineer; software developer; software development engineer; sde; full stack; fullstack; java developer; java engineer; java fsd; backend; back end; back-end; frontend; front end; front-end; web developer; application developer; angular; react; node; ui developer";
export const DEFAULT_ROLE_KEYWORDS = "software engineer; software developer; software development engineer; sde; full stack; fullstack; java developer; java engineer; java fsd; backend; back end; back-end; frontend; front end; front-end; web developer; application developer; angular; react; node; ui developer; java; spring boot; python developer; ai engineer; generative ai; genai; application engineer";
export function profileReason(r, s) {
  if (!s || !s.profileOnly) return "";
  const role = String(r.role || "").toLowerCase();
  if (s.skipSeniorTitles && /\b(principal|staff|architect|director|manager|head of|vp|vice president|distinguished)\b/i.test(role)) return "Senior title";
  const kws = String(s.roleKeywords || "").split(/[;\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const generic = /^(?:full[ -]?time|contract|w2|c2c|remote|hybrid|onsite|[\s\-–|:])*(developer|engineer|programmer|software)\s*(role|position|opening|opportunity)?$/i.test(role.trim()); // title says too little to judge
  if (kws.length && !generic && !kws.some(k => k === "se" || k === "sde" ? new RegExp("\\b" + k + "\\b").test(role) : role.includes(k))) return "Not your role";
  const max = (Number(s.maxYears) || 5) + (Number(s.yearsSlack) || 0);
  if (r.experienceYears !== null && r.experienceYears !== undefined && r.experienceYears > max) return `Asks ${r.experienceYears}+ years`;
  return "";
}

export function citizenOnly(visaLine, text) {
  const t = String(text || "").replace(/opt[- ]?out|opt out/gi, "");
  if (/\b(usc|us citizens?|u\.s\. citizens?|gc|green ?card|permanent residents?)\b[^\n]{0,30}\bonly\b|\bonly\b[^\n]{0,10}\b(usc|us citizens?|gc|green ?card)\b|\bcitizens? only\b|\bno (opt|stem|ead|h1b?)\b|must be (?:a |an )?(?:us |u\.s\. )?citizen|(?:us |u\.s\. )?citizenship (?:is )?required/i.test(t)) return true;
  const tokens = String(visaLine || "").toLowerCase().match(/usc|us citizen|citizens?|green ?card|gc[- ]?ead|\bgc\b|h-?1b?|h-?4|l-?2|\bopt\b|cpt|\bead\b|\btn\b|e-?3|any|all visas?/g);
  return !!tokens && tokens.every(x => /^(usc|us citizen|citizens?|green ?card|gc)$/.test(x));
}
export function visaFitFrom(text, visaLine = "") {
  const t = text.replace(/opt[- ]?out|opt out/gi, "");
  if (citizenOnly(visaLine, t)) return "no";
  if (/\bstem[ -]?opt\b|\bopt\b\s*(\/|,|ead|will|is|are|candidates|accepted|ok|okay|workable|also|fine)|\bopt\b[^.\n]{0,25}\b(welcome|accepted|ok|okay|fine|allowed|considered|workable|eligible)\b|\b(accept|accepts|accepting|welcome|consider|considering)\b[^.\n]{0,25}\bopt\b|\bany visa\b|\ball visas?\b|\bopen to all\b|visa\s*(independent|agnostic)/i.test(t)) return "ok";
  if (/\b(visa|work authori[sz]ation|usc|green ?card|gc[- ]?ead|h1b?|h4|l2|ead|w2|c2c|tn)\b/i.test(t)) return "check";
  return "unknown";
}

export function extract(subject, from, body) {
  const sp = parseSubject(subject);
  const b = (body || "").replace(/\r/g, "");
  const role = line(b, /(?:^|\n)\s*\**\s*(?:job title|position|role|title|designation)\s*\**\s*[:\-–]+\s*\**([^\n]+)/i) || sp.role;
  const location = line(b, /(?:^|\n)[^\n]{0,20}\blocation\b[^:\n]{0,20}[:\-–]+\s*\**([^\n]+)/i) || sp.location || "";
  const type = line(b, /(?:^|\n)[^\n]{0,10}\b(?:duration|job type|employment type|tax term|position type|type)\b\s*\**\s*[:\-–]+\s*\**([^\n]+)/i) || sp.type || "";
  const rateM = b.match(/\$\s?\d{2,3}(?:[,.]\d{3})?(?:\s*[-–]\s*\$?\s?\d{2,3}(?:[,.]\d{3})?)?\s*(?:k|\/\s*hr|\/hour|per hour|\/yr|per year|an hour|hr)?/i) || b.match(/rate\s*[:\-–]\s*([^\n]{2,40})/i);
  const rate = rateM ? (rateM[1] || rateM[0]).trim() : "";
  const experienceYears = yearsFrom(b.slice(0, 6000));
  const visa = line(b, /(?:^|\n)[^\n]{0,15}(?:visa|work authori[sz]ation)[^:\n]{0,20}[:\-–]+\s*([^\n]+)/i) || (b.match(/[^\n]*\b(usc|green card|gc[- ]?ead|h1b|opt|w2 only|only w2)\b[^\n]*/i)?.[0] || "").trim().slice(0, 140);
  const visaFit = visaFitFrom([subject, visa, b.slice(0, 5000)].join("\n"), visa);
  const mustTxt = section(b, /(must[- ]?haves?|mandatory|required skills|required qualifications|skills required|requirements?\s*[:\n]|key skills|primary skills|qualifications\s*[:\n]|skills\s*:|job description)/i, /(preferred|nice[- ]to[- ]have|good[- ]to[- ]have|desired|plus\b|bonus)/i, 2600);
  const niceTxt = section(b, /(preferred|nice[- ]to[- ]have|good[- ]to[- ]have|desired)/i, /(thanks|regards|best,|sincerely|unsubscribe)/i, 1400);
  let must = scanSkills([subject, mustTxt].join("\n"));
  if (!must.length) must = scanSkills([subject, b.slice(0, 4000)].join("\n"));
  const nice = scanSkills(niceTxt).filter(s => !must.includes(s));
  const sig = b.match(/(?:[Rr]egards|REGARDS|[Tt]hanks|THANKS|[Tt]hank you|[Bb]est|[Ss]incerely|[Cc]heers)[,!.\s]*\n+\s*\**\s*([A-Z][a-z]{2,})(?:\s+[A-Z][a-z]+)?/);
  const local = from.split("@")[0] || "";
  const SIG_JUNK = /^(the|team|your|our|this|with|and|for|please|regards|thanks|best|talent|recruiter|technical|senior|sr|hr)$/i;
  const recruiterName = sig && !SIG_JUNK.test(sig[1]) ? sig[1] : (/[._]/.test(local) ? cap(local.split(/[._]/)[0]) : /^[a-z]{3,8}$/i.test(local) ? cap(local) : "");
  const vendor = cap(domainOf(from).split(".").slice(-2, -1)[0] || "");
  const mode = /\bremote\b/i.test(location + " " + subject) ? "Remote" : /\bhybrid\b/i.test(location + " " + subject) ? "Hybrid" : /\bon-?site\b/i.test(location + " " + subject) ? "Onsite" : "";
  const terms = /\bw2\b[^\n]{0,10}only|only[^\n]{0,6}\bw2\b/i.test(subject + " " + b.slice(0, 3000)) ? "W2 only" : /\bc2c\b/i.test(subject) ? "C2C" : "";
  return { role: role.slice(0, 120), location, mode, type, terms, rate, rateHourly: rateHourly(rate), experienceYears, visa, visaFit, clearance: needsClearance(subject + "\n" + b.slice(0, 6000)), client: clientFrom(subject, b), must: must.slice(0, 16), nice: nice.slice(0, 12), recruiterName, vendor };
}

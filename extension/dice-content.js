// Requirement Inbox on dice.com: a match panel on job pages, quiet capture of the jobs you browse,
// and a note when you click Apply. It never applies or submits anything for you.
(() => {
  if (window.top !== window || window.__rqiDice) return;
  window.__rqiDice = true;
  const UUID = /job-detail\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const send = msg => chrome.runtime.sendMessage(msg).catch(() => null);
  let lastUrl = "", detailId = null, scanTimer = null;
  const reported = new Set();

  // elements inside web components' shadow roots too
  function deepAll(root, sel, out = []) {
    root.querySelectorAll(sel).forEach(el => out.push(el));
    root.querySelectorAll("*").forEach(el => { if (el.shadowRoot) deepAll(el.shadowRoot, sel, out); });
    return out;
  }

  // ---------- panel ----------
  const panel = document.createElement("div");
  panel.id = "rqi-dice"; panel.hidden = true;
  document.documentElement.appendChild(panel);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FIT = { ok: ["OPT accepted", "ok"], check: ["Visa unclear", "warn"], no: ["USC / GC only", "bad"], unknown: ["Visa not stated", "mute"] };
  function renderPanel(info) {
    if (!info || !info.found) { panel.hidden = true; return; }
    const yearsOk = info.years === null || info.years === undefined ? null : info.years <= info.myYears;
    const [fitLabel, fitCls] = FIT[info.visaFit] || FIT.unknown;
    const applied = info.status === "applied";
    panel.innerHTML = `<div class="rqi-hd"><strong>Requirement Inbox</strong><button class="rqi-x" data-rqi="close" aria-label="Hide">×</button></div>
      <div class="rqi-role">${esc(info.role)}</div>
      ${info.filterReason ? `<div class="rqi-row bad">Doesn't match your profile: ${esc(info.filterReason)}</div>` : `<div class="rqi-row ok">Matches your profile</div>`}
      <div class="rqi-chips"><span class="${fitCls}">${fitLabel}</span>${yearsOk === null ? `<span class="mute">Years not stated</span>` : `<span class="${yearsOk ? "ok" : "warn"}">Asks ${info.years}+ yrs</span>`}${info.clearance ? `<span class="bad">Clearance</span>` : ""}</div>
      ${info.skills.total ? `<div class="rqi-row">${info.skills.resume ? `${info.skills.hit} of ${info.skills.total} skills in ${esc(info.skills.resume)}` : `${info.skills.total} skills listed`}${info.skills.gaps.length ? `<div class="rqi-gaps">Gaps: ${esc(info.skills.gaps.slice(0, 6).join(", "))}</div>` : ""}</div>` : ""}
      ${info.visa ? `<div class="rqi-quote">“${esc(info.visa.slice(0, 140))}”</div>` : ""}
      <div class="rqi-acts">${applied ? `<span class="ok">Applied ${esc(new Date(info.appliedAt).toLocaleDateString([], { month: "short", day: "numeric" }))}</span><button data-rqi="unapply">Undo</button>` : `<button data-rqi="applied">Mark applied</button>`}<button data-rqi="open">Open dashboard</button></div>`;
    panel.hidden = false;
  }
  panel.addEventListener("click", async e => {
    const a = e.target.closest("[data-rqi]")?.dataset.rqi; if (!a) return;
    if (a === "close") panel.hidden = true;
    if (a === "open") send({ type: "open-dashboard" });
    if (a === "applied" || a === "unapply") renderPanel(await send({ type: "dice-applied", id: detailId, applied: a === "applied" }));
  });

  // ---------- job page ----------
  async function onJobPage(id) {
    detailId = id;
    panel.hidden = true;
    await new Promise(r => setTimeout(r, 1500)); // let the page render
    if (detailId !== id) return;
    const html = document.documentElement.outerHTML.slice(0, 1500000);
    const title = (document.querySelector("h1")?.innerText || "").trim();
    const text = (document.querySelector("main")?.innerText || document.body.innerText || "").slice(0, 9000);
    renderPanel(await send({ type: "dice-job", id, html, title, text }));
  }
  // your click on Dice's own Apply button is noted, so the dashboard and duplicate guard know
  document.addEventListener("click", async e => {
    if (!detailId || panel.contains(e.target)) return;
    const hit = e.composedPath().some(el => el && el.nodeType === 1 && (
      /apply/i.test(el.tagName) || (/^(easy apply|apply now|apply|quick apply)$/i.test((el.innerText || el.textContent || "").trim()) && (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute?.("role") === "button"))));
    if (hit) setTimeout(async () => renderPanel(await send({ type: "dice-applied", id: detailId })), 800);
  }, true);

  // ---------- search results ----------
  function scan() {
    const items = [];
    for (const a of deepAll(document, 'a[href*="job-detail/"]')) {
      const m = (a.getAttribute("href") || "").match(UUID); if (!m) continue;
      const id = m[1].toLowerCase(); if (reported.has(id)) continue;
      reported.add(id);
      const title = (a.innerText || a.textContent || "").trim().slice(0, 140);
      items.push({ id, title: /^(apply|easy apply|view)/i.test(title) ? "" : title });
    }
    if (!items.length) return;
    send({ type: "dice-ids", items }).then(r => {
      if (r?.checked) toast(`Requirement Inbox checked ${r.checked} job${r.checked === 1 ? "" : "s"}: ${r.added} match your profile${r.filtered ? `, ${r.filtered} don't` : ""}.`);
    });
  }
  const scheduleScan = () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 2000); };
  const t = document.createElement("div"); t.id = "rqi-toast"; t.hidden = true; document.documentElement.appendChild(t);
  function toast(msg) { t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 5000); }

  // Dice is a single-page app: watch for page changes
  function onChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const m = location.pathname.match(UUID);
      if (m) onJobPage(m[1].toLowerCase()); else { detailId = null; panel.hidden = true; }
    }
    if (/^\/jobs/.test(location.pathname)) scheduleScan();
  }
  new MutationObserver(() => { if (/^\/jobs/.test(location.pathname) || location.href !== lastUrl) onChange(); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(onChange, 1500);
  onChange();
})();

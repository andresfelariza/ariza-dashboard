/**
 * DashboardPlugins.school: renders kids' school cards from window.__SCHOOL_DATA,
 * which is embedded into the encrypted page at publish time. No data lives here.
 */
(function () {
  "use strict";
  const DAY = 86400000;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const d0 = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  function when(iso) {
    const diff = Math.round((d0(iso) - today()) / DAY);
    const md = (d0(iso).getMonth() + 1) + "/" + d0(iso).getDate();
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff > 1 && diff < 7) return d0(iso).toLocaleDateString("en-US", { weekday: "short" }) + " " + md;
    return md;
  }
  const isTest = (t) => /\b(test|quiz|exam|assessment)\b/i.test(t);
  function render() {
    const data = window.__SCHOOL_DATA;
    if (!data || !data.students) return;
    const upd = new Date(data.updated.replace(/(T\d\d:\d\d)(-|\+)/, "$1:00$2"));
    const updTxt = isNaN(upd) ? data.updated : upd.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
    data.students.forEach((s, i) => {
      const el = document.getElementById("school-card-" + i);
      if (!el) return;
      const kid = el.dataset.kid || "";
      const grades = s.classes.map(([n, l, p]) => {
        const low = !/^A/.test(l);
        return `<div class="sg${low ? " low" : ""}"><span class="sg-name">${esc(n)}</span><span class="sg-g">${esc(l)}<small>${Math.round(p)}%</small></span></div>`;
      }).join("");
      const t = today();
      const soon = (s.upcoming || []).filter((u) => { const d = (d0(u.due) - t) / DAY; return d >= 0 && d <= 14; })
        .sort((a, b) => a.due.localeCompare(b.due));
      const missing = s.missing || [];
      let side = "";
      if (missing.length) side += `<div class="school-list school-missing"><div class="section-label">Missing (${missing.length})</div>` +
        missing.map((m) => `<div class="si"><span class="when">${esc(m.class)}:</span>${esc(m.title)}</div>`).join("") + "</div>";
      side += `<div class="school-list school-soon"><div class="section-label">Coming up · 14 days</div>` +
        (soon.length ? soon.map((u) => `<div class="si${isTest(u.title) ? " big" : ""}"><span class="when">${esc(when(u.due))}</span>${esc(u.class)}: ${esc(u.title)}</div>`).join("")
          : `<div class="school-none">Nothing due${missing.length ? "" : " · nothing missing"}</div>`) + "</div>";
      el.innerHTML = `<div class="kid-header"><div><div class="kid-name ${esc(kid)}">${esc(s.name)}</div>
        <div class="kid-meta">${esc(s.grade)} grade</div></div><div class="school-updated">Updated ${esc(updTxt)}</div></div>
        <div class="school-body"><div class="school-grades">${grades}</div><div class="school-side">${side}</div></div>`;
    });
  }
  (window.DashboardPlugins = window.DashboardPlugins || {}).school = { render };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render); else render();
  setInterval(render, 30 * 60 * 1000);
})();

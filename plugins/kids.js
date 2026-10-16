/**
 * DashboardPlugins.kids — compact Homework & chores strip + full-screen kid pages.
 * Grades/homework live only on the kid overlay (auto-closes after idle).
 * Optional PIN gate: window.__KID_PIN = { enabled:false, pins:{} } (casual guard only).
 */
(function () {
  "use strict";
  const DAY = 86400000;
  const IDLE_MS = 2 * 60 * 1000;
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const d0 = (iso) => {
    const s = String(iso || "").slice(0, 10);
    const [y, m, d] = s.split("-").map(Number);
    if (!y) return new Date(NaN);
    return new Date(y, m - 1, d);
  };
  const today = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  const norm = (v) => String(v || "").trim().toLowerCase();
  const isTest = (t) => /\b(test|quiz|exam|assessment)\b/i.test(t || "");

  function whenLabel(iso) {
    const dt = d0(iso);
    if (isNaN(dt)) return "";
    const diff = Math.round((dt - today()) / DAY);
    const md = dt.getMonth() + 1 + "/" + dt.getDate();
    if (diff < 0) return "Overdue " + md;
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff > 1 && diff < 7) return dt.toLocaleDateString("en-US", { weekday: "short" }) + " " + md;
    return md;
  }
  function formatUpdated(iso) {
    if (!iso) return "unknown";
    const upd = new Date(String(iso).replace(/(T\d\d:\d\d)([+-])/, "$1:00$2"));
    if (isNaN(upd)) return String(iso);
    return upd.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function weekRange() {
    const t = today();
    const sun = new Date(t);
    sun.setDate(t.getDate() - t.getDay());
    const end = new Date(sun);
    end.setDate(sun.getDate() + 7);
    return { start: sun, end };
  }
  function pinConfig() {
    return window.__KID_PIN || { enabled: false, pins: {} };
  }
  function pageCfg(kid) {
    const cfg = (window.__KID_PAGE_CFG && window.__KID_PAGE_CFG[kid]) || {};
    return cfg;
  }
  function studentFor(kid, index) {
    const students = (window.__SCHOOL_DATA && window.__SCHOOL_DATA.students) || [];
    const byName = students.find((s) => norm(s.name) === norm(kid) || norm(s.name).startsWith(norm(kid).slice(0, 3)));
    if (byName) return byName;
    return students[index] || { name: pageCfg(kid).short || ("Kid " + (index + 1)), grade: "", classes: [], missing: [], upcoming: [] };
  }
  function tutorTasks(kid) {
    const now = Date.now();
    const tasks = (window.__TUTOR_TASKS && window.__TUTOR_TASKS.tasks) || [];
    return tasks.filter((t) => {
      if (norm(t.kid) !== norm(kid)) return false;
      const st = (t.status || "todo").toLowerCase();
      if (st === "todo") return true;
      if (st !== "done") return false;
      const doneAt = t.done_at ? Date.parse(t.done_at) : NaN;
      return !isNaN(doneAt) && now - doneAt < DAY;
    });
  }
  function homeworkItems(student, days) {
    const t = today();
    const missing = (student.missing || []).map((m) => ({
      kind: "missing",
      class: m.class,
      title: m.title,
      due: m.due,
      test: isTest(m.title),
      sort: (m.due || "0000") + "-0",
    }));
    const upcoming = (student.upcoming || [])
      .filter((u) => {
        const d = (d0(u.due) - t) / DAY;
        return d >= 0 && d <= days;
      })
      .map((u) => ({
        kind: u && isTest(u.title) ? "test" : "due",
        class: u.class,
        title: u.title,
        due: u.due,
        test: isTest(u.title),
        sort: (u.due || "9999") + "-1",
      }));
    return { missing, upcoming };
  }
  function previewItems(kid, student) {
    const tutors = tutorTasks(kid)
      .filter((t) => (t.status || "todo").toLowerCase() !== "done")
      .map((t) => ({
        kind: "tutor",
        title: t.title,
        due: t.due,
        url: t.url,
        sort: (String(t.due || "9999").slice(0, 10)) + "-t",
      }));
    const { missing, upcoming } = homeworkItems(student, 7);
    const miss = missing.map((m) => ({ kind: "missing", title: (m.class ? m.class + ": " : "") + m.title, due: m.due, sort: m.sort }));
    const due = upcoming.map((u) => ({
      kind: u.test ? "test" : "due",
      title: (u.class ? u.class + ": " : "") + u.title,
      due: u.due,
      sort: u.sort,
    }));
    const all = [...tutors, ...miss, ...due].sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
    return { all, missingCount: missing.length, total: all.length };
  }
  function weekActivities(kid) {
    const { start, end } = weekRange();
    const events = window.EVENTS || {};
    return Object.keys(events)
      .map((k) => events[k])
      .filter((e) => e && norm(e.who) === norm(kid))
      .filter((e) => {
        const d = d0(e.date);
        return !isNaN(d) && d >= start && d < end;
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.timeLabel || "").localeCompare(String(b.timeLabel || "")));
  }

  let openKid = null;
  let idleTimer = null;
  let pinBuffer = "";

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }
  function armIdle() {
    clearIdle();
    if (!openKid) return;
    idleTimer = setTimeout(() => closeKidPage("idle"), IDLE_MS);
  }
  function bumpIdle() {
    if (openKid) armIdle();
  }

  function renderStrip() {
    const root = document.getElementById("kids-strip");
    if (!root) return;
    const school = window.__SCHOOL_DATA;
    const expired = !!window.__SCHOOL_SESSION_EXPIRED;
    const upd = formatUpdated(school && school.updated);
    const slots = [...root.querySelectorAll(".kids-strip-kid")];
    slots.forEach((slot, i) => {
      const kid = slot.dataset.kid;
      const cfg = pageCfg(kid);
      const student = studentFor(kid, i);
      const { all, missingCount, total } = previewItems(kid, student);
      const preview = all.slice(0, 3);
      const more = Math.max(0, total - preview.length);
      const short = esc(cfg.short || student.name || "Open");
      const rows = preview.length
        ? preview
            .map((it) => {
              const badge =
                it.kind === "missing" ? '<span class="ks-dot" title="Missing"></span>' :
                it.kind === "tutor" ? '<span class="ks-tag">🎓</span>' :
                it.kind === "test" ? '<span class="ks-tag test">Test</span>' : "";
              const due = it.due ? `<span class="ks-due">${esc(whenLabel(it.due))}</span>` : "";
              return `<div class="ks-item ${esc(it.kind)}">${badge}<span class="ks-text">${esc(it.title)}</span>${due}</div>`;
            })
            .join("")
        : `<div class="ks-item none">Nothing due</div>`;
      const missLabel = missingCount ? `<span class="ks-miss">${missingCount} missing</span>` : "";
      const countLabel = `<span class="ks-count">${total} item${total === 1 ? "" : "s"}</span>`;
      slot.innerHTML =
        `<button type="button" class="ks-open" data-open-kid="${esc(kid)}" aria-label="Open ${short} page">` +
        `<span class="ks-name">${short} <span aria-hidden="true">›</span></span>` +
        `<span class="ks-stats">${countLabel}${missLabel}</span></button>` +
        `<div class="ks-preview">${rows}${more ? `<div class="ks-more">+${more} more</div>` : ""}</div>`;
    });
    const meta = document.getElementById("kids-strip-meta");
    if (meta) {
      meta.innerHTML =
        `School data · ${esc(upd)}` +
        (expired ? ` · <span class="ks-signin">School portal sign-in needed</span>` : "");
    }
    root.querySelectorAll("[data-open-kid]").forEach((btn) => {
      btn.addEventListener("click", () => openKidPage(btn.getAttribute("data-open-kid")));
    });
  }

  function renderKidPage(kid) {
    const layer = document.getElementById("kid-layer");
    const body = document.getElementById("kid-layer-body");
    if (!layer || !body) return;
    const cfg = pageCfg(kid);
    const slots = [...document.querySelectorAll(".kids-strip-kid")];
    const index = Math.max(0, slots.findIndex((el) => el.dataset.kid === kid));
    const student = studentFor(kid, index);
    const { missing, upcoming } = homeworkItems(student, 14);
    const tutors = tutorTasks(kid);
    const activities = weekActivities(kid);
    const school = window.__SCHOOL_DATA;
    const expired = !!window.__SCHOOL_SESSION_EXPIRED;
    const accent = cfg.accent || "var(--accent)";

    layer.dataset.kid = kid;
    layer.style.setProperty("--kid-accent", accent);
    layer.classList.add("open");
    layer.setAttribute("aria-hidden", "false");
    document.body.classList.add("kid-page-open");

    const grades = (student.classes || [])
      .map((row) => {
        const n = row[0], l = row[1], p = row[2];
        const low = !/^A/.test(String(l || ""));
        return `<div class="kp-grade${low ? " low" : ""}"><span class="kp-gname">${esc(n)}</span><span class="kp-gmark">${esc(l)}<small>${Math.round(Number(p) || 0)}%</small></span></div>`;
      })
      .join("");

    const missHtml = missing.length
      ? missing.map((m) => `<div class="kp-row missing"><span class="kp-when">${esc(m.class)}:</span> ${esc(m.title)} <span class="kp-meta">${esc(whenLabel(m.due))}</span></div>`).join("")
      : `<div class="kp-none">Nothing missing</div>`;

    const tests = upcoming.filter((u) => u.test);
    const testHtml = tests.length
      ? tests.map((u) => `<div class="kp-row test"><span class="kp-when">${esc(whenLabel(u.due))}</span> ${esc(u.class)}: ${esc(u.title)}</div>`).join("")
      : `<div class="kp-none">No tests in the next 14 days</div>`;

    const dueHtml = upcoming.length
      ? upcoming.map((u) => `<div class="kp-row${u.test ? " test" : ""}"><span class="kp-when">${esc(whenLabel(u.due))}</span> ${esc(u.class)}: ${esc(u.title)}</div>`).join("")
      : `<div class="kp-none">Nothing due in the next 14 days</div>`;

    const tutorHtml = tutors.length
      ? tutors
          .map((t) => {
            const done = (t.status || "").toLowerCase() === "done";
            const title = esc(t.title || "Practice");
            const link = done
              ? `<span class="kp-done">✓ ${title}</span>`
              : `<a href="${esc(t.url || "#")}" target="_blank" rel="noopener">${title}</a>`;
            return `<div class="kp-row tutor">${link}<span class="kp-tag">🎓 Tutor</span><span class="kp-meta">${t.minutes ? "~" + esc(t.minutes) + " min · " : ""}${esc(whenLabel(t.due))}</span></div>`;
          })
          .join("")
      : `<div class="kp-none">No Tutor tasks</div>`;

    const actHtml = activities.length
      ? activities
          .map((e) => `<div class="kp-row activity"><span class="kp-when">${esc(String(e.date).slice(5))} · ${esc(e.timeLabel || "")}</span> ${esc(e.short || e.title || "")}</div>`)
          .join("")
      : `<div class="kp-none">No activities this week</div>`;

    const practice = cfg.practice || null;
    const practiceHtml = practice
      ? `<a class="kp-practice btn btn-practice" href="${esc(practice.url)}" target="_blank" rel="noopener">${esc(practice.icon || "🎮")} ${esc(practice.title || "Practice")}</a>`
      : "";

    const display = esc(cfg.short || student.name || "Kid");
    body.innerHTML =
      `<div class="kp-top"><button type="button" class="kp-back" id="kid-back">← Back</button>` +
      `<div class="kp-title"><div class="kp-name">${display}</div><div class="kp-sub">${esc(student.grade || "")} grade · Homework & school</div></div>` +
      `${practiceHtml}</div>` +
      `<div class="kp-grid">` +
      `<section class="kp-card"><h3>Grades</h3><div class="kp-grades">${grades || '<div class="kp-none">No grades yet</div>'}</div></section>` +
      `<section class="kp-card"><h3>Missing</h3>${missHtml}</section>` +
      `<section class="kp-card"><h3>Upcoming tests</h3>${testHtml}</section>` +
      `<section class="kp-card"><h3>Due next 14 days</h3>${dueHtml}</section>` +
      `<section class="kp-card"><h3>Tutor tasks</h3>${tutorHtml}</section>` +
      `<section class="kp-card"><h3>This week</h3>${actHtml}</section>` +
      `</div>` +
      `<div class="kp-footer">School data · ${esc(formatUpdated(school && school.updated))}` +
      (expired ? ` · <span class="ks-signin">School portal sign-in needed</span>` : "") +
      ` · Closes after 2 min idle</div>`;

    const back = document.getElementById("kid-back");
    if (back) back.addEventListener("click", () => closeKidPage("back"));
  }

  function showPinGate(kid) {
    const layer = document.getElementById("kid-layer");
    const body = document.getElementById("kid-layer-body");
    if (!layer || !body) return;
    const cfg = pageCfg(kid);
    pinBuffer = "";
    layer.dataset.kid = kid;
    layer.style.setProperty("--kid-accent", cfg.accent || "var(--accent)");
    layer.classList.add("open");
    layer.setAttribute("aria-hidden", "false");
    document.body.classList.add("kid-page-open");
    body.innerHTML =
      `<div class="kp-pin">` +
      `<button type="button" class="kp-back" id="kid-back">← Back</button>` +
      `<div class="kp-name">${esc(cfg.short || "Kid")}</div>` +
      `<p class="kp-pin-help">Enter 4-digit PIN</p>` +
      `<div class="kp-pin-dots" id="kp-pin-dots"><span></span><span></span><span></span><span></span></div>` +
      `<div class="kp-pin-pad" id="kp-pin-pad">` +
      [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map((k) =>
        k === "" ? `<span></span>` : `<button type="button" data-k="${k}">${k}</button>`
      ).join("") +
      `</div><p class="kp-pin-note">Casual privacy only — same encrypted page.</p></div>`;
    document.getElementById("kid-back").addEventListener("click", () => closeKidPage("back"));
    document.getElementById("kp-pin-pad").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-k]");
      if (!b) return;
      const k = b.getAttribute("data-k");
      if (k === "⌫") pinBuffer = pinBuffer.slice(0, -1);
      else if (pinBuffer.length < 4) pinBuffer += k;
      const dots = [...document.querySelectorAll("#kp-pin-dots span")];
      dots.forEach((d, i) => d.classList.toggle("on", i < pinBuffer.length));
      if (pinBuffer.length === 4) {
        const expect = String((pinConfig().pins || {})[kid] || "");
        if (expect && pinBuffer === expect) {
          renderKidPage(kid);
          armIdle();
        } else {
          pinBuffer = "";
          dots.forEach((d) => d.classList.remove("on"));
          body.classList.add("kp-pin-bad");
          setTimeout(() => body.classList.remove("kp-pin-bad"), 400);
        }
      }
    });
  }

  function openKidPage(kid) {
    if (!kid) return;
    openKid = kid;
    const pin = pinConfig();
    const needPin = !!(pin.enabled && pin.pins && pin.pins[kid]);
    if (needPin) showPinGate(kid);
    else {
      renderKidPage(kid);
      armIdle();
    }
    bumpIdle();
  }

  function closeKidPage(_reason) {
    openKid = null;
    clearIdle();
    pinBuffer = "";
    const layer = document.getElementById("kid-layer");
    if (layer) {
      layer.classList.remove("open");
      layer.setAttribute("aria-hidden", "true");
      delete layer.dataset.kid;
    }
    document.body.classList.remove("kid-page-open");
    const body = document.getElementById("kid-layer-body");
    if (body) body.innerHTML = "";
  }

  function onActivity() {
    bumpIdle();
  }

  function render() {
    renderStrip();
  }

  // Test hook: allow fake timers / forced idle in verification
  const api = {
    render,
    openKidPage,
    closeKidPage,
    armIdle,
    forceIdle: () => closeKidPage("idle"),
    getOpenKid: () => openKid,
    IDLE_MS,
  };
  (window.DashboardPlugins = window.DashboardPlugins || {}).kids = api;
  window.__kidsApi = api; // headless verification

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
  setInterval(renderStrip, 30 * 60 * 1000);

  ["pointerdown", "keydown", "touchstart"].forEach((ev) => {
    document.addEventListener(ev, onActivity, { passive: true });
  });
})();

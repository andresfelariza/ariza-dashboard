/**
 * DashboardPlugins.homework: per-kid Homework cards from
 * window.__SCHOOL_DATA (assignments only — no grades) +
 * window.__TUTOR_TASKS. Session-expired note from window.__SCHOOL_SESSION_EXPIRED.
 */
(function () {
  "use strict";
  const DAY = 86400000;
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const d0 = (iso) => {
    const s = String(iso).slice(0, 10);
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const today = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  function whenLabel(iso) {
    const diff = Math.round((d0(iso) - today()) / DAY);
    const md = d0(iso).getMonth() + 1 + "/" + d0(iso).getDate();
    if (diff < 0) return "Overdue " + md;
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff > 1 && diff < 7) return d0(iso).toLocaleDateString("en-US", { weekday: "short" }) + " " + md;
    return md;
  }
  function dateHeading(iso) {
    const diff = Math.round((d0(iso) - today()) / DAY);
    const long = d0(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    if (diff === 0) return "Today · " + long;
    if (diff === 1) return "Tomorrow · " + long;
    return long;
  }
  const isTest = (t) => /\b(test|quiz|exam|assessment)\b/i.test(t || "");
  function formatUpdated(iso) {
    if (!iso) return "unknown";
    const upd = new Date(String(iso).replace(/(T\d\d:\d\d)([+-])/, "$1:00$2"));
    if (isNaN(upd)) return String(iso);
    return upd.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function normKid(v) {
    return String(v || "").trim().toLowerCase();
  }
  function visibleTutorTasks(tasks, kid) {
    const now = Date.now();
    const k = normKid(kid);
    return (tasks || []).filter((t) => {
      if (normKid(t.kid) !== k) return false;
      const st = (t.status || "todo").toLowerCase();
      if (st === "todo") return true;
      if (st !== "done") return false;
      const doneAt = t.done_at ? Date.parse(t.done_at) : NaN;
      if (isNaN(doneAt)) return false;
      return now - doneAt < DAY;
    });
  }
  function schoolItemsFor(student) {
    const t = today();
    const missing = (student.missing || []).map((m) => ({
      kind: "missing",
      class: m.class,
      title: m.title,
      due: m.due,
      test: isTest(m.title),
    }));
    const upcoming = (student.upcoming || [])
      .filter((u) => {
        const d = (d0(u.due) - t) / DAY;
        return d >= 0 && d <= 7;
      })
      .map((u) => ({
        kind: "due",
        class: u.class,
        title: u.title,
        due: u.due,
        test: isTest(u.title),
      }));
    return { missing, upcoming };
  }
  function groupByDue(items) {
    const map = new Map();
    items.forEach((it) => {
      const k = String(it.due || "").slice(0, 10) || "unknown";
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  function renderTutor(list) {
    if (!list.length) return "";
    return (
      `<div class="hw-block hw-tutor"><div class="section-label">Tutor practice</div>` +
      list
        .map((t) => {
          const done = (t.status || "").toLowerCase() === "done";
          const mins = t.minutes ? ` · ~${esc(t.minutes)} min` : "";
          const due = t.due ? ` · due ${esc(whenLabel(t.due))}` : "";
          const title = esc(t.title || "Practice");
          const inner = done
            ? `<span class="hw-check" aria-hidden="true">✓</span><span class="hw-title done">${title}</span>`
            : `<a class="hw-title" href="${esc(t.url || "#")}" target="_blank" rel="noopener">${title}</a>`;
          return `<div class="hw-row tutor${done ? " is-done" : ""}">${inner}<span class="hw-tag">🎓 Tutor</span><span class="hw-meta">${mins}${due}</span></div>`;
        })
        .join("") +
      `</div>`
    );
  }
  function renderMissing(list) {
    if (!list.length) return "";
    return (
      `<div class="hw-block hw-missing"><div class="section-label">Missing</div>` +
      list
        .map(
          (m) =>
            `<div class="hw-row missing${m.test ? " test" : ""}"><span class="hw-when">${esc(m.class)}:</span> ${esc(m.title)}${
              m.due ? ` <span class="hw-meta">· was due ${esc(whenLabel(m.due))}</span>` : ""
            }</div>`
        )
        .join("") +
      `</div>`
    );
  }
  function renderUpcoming(list) {
    const groups = groupByDue(list);
    if (!groups.length) {
      return `<div class="hw-block hw-soon"><div class="section-label">Due next 7 days</div><div class="hw-none">Nothing due from school</div></div>`;
    }
    return (
      `<div class="hw-block hw-soon"><div class="section-label">Due next 7 days</div>` +
      groups
        .map(([due, items]) => {
          const head = `<div class="hw-day">${esc(dateHeading(due))}</div>`;
          const rows = items
            .map(
              (u) =>
                `<div class="hw-row${u.test ? " test" : ""}"><span class="hw-when">${esc(u.class)}:</span> ${esc(u.title)}${
                  u.test ? ' <span class="hw-tag test-tag">Test</span>' : ""
                }</div>`
            )
            .join("");
          return head + rows;
        })
        .join("") +
      `</div>`
    );
  }
  function render() {
    const school = window.__SCHOOL_DATA;
    const tutor = window.__TUTOR_TASKS;
    const expired = !!window.__SCHOOL_SESSION_EXPIRED;
    const tasks = (tutor && tutor.tasks) || [];
    const students = (school && school.students) || [];
    const updTxt = formatUpdated(school && school.updated);
    [0, 1].forEach((i) => {
      const el = document.getElementById("homework-card-" + i);
      if (!el) return;
      const kid = normKid(el.dataset.kid || "");
      const s = students[i] || { name: kid || ("Student " + (i + 1)), missing: [], upcoming: [] };
      const { missing, upcoming } = schoolItemsFor(s);
      const tutorList = visibleTutorTasks(tasks, kid || normKid(s.name));
      const empty = !tutorList.length && !missing.length && !upcoming.length;
      let body = renderTutor(tutorList) + renderMissing(missing) + renderUpcoming(upcoming);
      if (empty) body = `<div class="hw-none">No homework due</div>`;
      const signIn = expired
        ? `<div class="hw-signin">School portal sign-in needed</div>`
        : "";
      const displayName = esc(s.name || kid || ("Student " + (i + 1)));
      const kidClass = esc(kid);
      el.innerHTML =
        `<div class="kid-header"><div><div class="kid-name ${kidClass}">${displayName}</div>` +
        `<div class="kid-meta">Homework</div></div>` +
        `<div class="school-updated">School data · ${esc(updTxt)}</div></div>` +
        `<div class="hw-body">${body}</div>${signIn}`;
    });
  }
  (window.DashboardPlugins = window.DashboardPlugins || {}).homework = { render };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
  setInterval(render, 30 * 60 * 1000);
})();

/**
 * DashboardPlugins.trash — trash / recycling pickup reminder (Tigard-style Tue morning).
 * Trash every week; recycling every other week.
 * Anchor: week of Mon 2026-10-12 = trash only; Mon 2026-10-19 = trash + recycling.
 */
(function (global) {
  "use strict";

  const TZ = "America/Los_Angeles";
  // First trash-only Monday (take bins out Mon night for Tue pickup)
  const ANCHOR_MONDAY = "2026-10-12";

  function tzParts(d) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      hour12: false,
      minute: "2-digit",
    });
    const map = {};
    fmt.formatToParts(d).forEach((p) => {
      if (p.type !== "literal") map[p.type] = p.value;
    });
    // hour can be 24 in some engines for midnight — normalize
    let hour = Number(map.hour);
    if (hour === 24) hour = 0;
    return {
      weekday: map.weekday,
      year: map.year,
      month: map.month,
      day: map.day,
      hour: hour,
      ymd: map.year + "-" + map.month + "-" + map.day,
    };
  }

  function ymdToUTCDate(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function addDaysYmd(ymd, n) {
    const dt = ymdToUTCDate(ymd);
    dt.setUTCDate(dt.getUTCDate() + n);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function daysBetween(a, b) {
    return Math.round((ymdToUTCDate(b) - ymdToUTCDate(a)) / 86400000);
  }

  /** Monday ymd on or before the given local ymd */
  function mondayOnOrBefore(ymd) {
    const dt = ymdToUTCDate(ymd);
    const dow = dt.getUTCDay(); // 0=Sun
    const back = dow === 0 ? 6 : dow - 1;
    return addDaysYmd(ymd, -back);
  }

  function includesRecycling(mondayYmd) {
    const weeks = Math.round(daysBetween(ANCHOR_MONDAY, mondayYmd) / 7);
    // week 0 (Oct 13) trash only; week 1 (Oct 20) recycling; …
    return ((weeks % 2) + 2) % 2 === 1;
  }

  function serviceLabel(recycling) {
    return recycling ? "Trash + Recycling" : "Trash";
  }

  function nextMonday(fromYmd, weekday, hour) {
    // If today is Monday, that Monday; else upcoming Monday
    if (weekday === "Mon") return fromYmd;
    const dt = ymdToUTCDate(fromYmd);
    const dow = dt.getUTCDay();
    const ahead = dow === 0 ? 1 : 8 - dow;
    return addDaysYmd(fromYmd, ahead);
  }

  const TrashPlugin = {
    id: "trash",
    timer: null,

    compute: function (now) {
      now = now || new Date();
      const p = tzParts(now);
      const isMonday = p.weekday === "Mon";
      const mon = isMonday ? p.ymd : nextMonday(p.ymd, p.weekday, p.hour);
      // For non-Monday, "next pickup" is the Tuesday after upcoming Monday
      const serviceMon = isMonday ? p.ymd : mondayOnOrBefore(mon) === mon ? mon : mondayOnOrBefore(addDaysYmd(p.ymd, 7));
      // simplify: upcoming take-out Monday
      let takeOutMonday = p.ymd;
      if (!isMonday) {
        const dow = ymdToUTCDate(p.ymd).getUTCDay();
        const ahead = dow === 0 ? 1 : 8 - dow;
        takeOutMonday = addDaysYmd(p.ymd, ahead);
      }
      const recycling = includesRecycling(takeOutMonday);
      const label = serviceLabel(recycling);
      const emphasize = isMonday && p.hour >= 17;
      let line, sub;
      if (isMonday) {
        line = "Tonight: " + label;
        sub = emphasize ? "Bins out tonight · pickup Tue morning" : "Take bins out tonight";
      } else {
        line = "Next pickup Tue: " + label;
        sub = "Set out Monday night";
      }
      return {
        isMonday,
        emphasize,
        recycling,
        line,
        sub,
        takeOutMonday,
      };
    },

    renderChip: function () {
      const chip = document.getElementById("trash-chip");
      if (!chip) return;
      const info = this.compute();
      chip.classList.toggle("is-tonight", !!info.isMonday);
      chip.classList.toggle("is-emphasize", !!info.emphasize);
      chip.classList.toggle("has-recycling", !!info.recycling);
      const icon = chip.querySelector(".trash-icon");
      const main = chip.querySelector(".trash-main");
      const meta = chip.querySelector(".trash-sub");
      if (icon) icon.textContent = info.recycling ? "♻️" : "🗑️";
      if (main) main.textContent = info.line;
      if (meta) meta.textContent = info.sub;
      chip.setAttribute("aria-label", info.line + ". " + info.sub);
    },

    openModal: function () {
      if (typeof global.openModal !== "function") return;
      const info = this.compute();
      const html =
        '<div class="modal-section"><p><strong>Pickup:</strong> Tuesday morning</p>' +
        "<p><strong>Take bins out:</strong> Monday night</p>" +
        "<p><strong>Trash:</strong> every week</p>" +
        "<p><strong>Recycling:</strong> every other week</p></div>" +
        '<div class="modal-section"><div class="modal-label">This cycle</div><p>' +
        (info.isMonday ? "Tonight: " : "Next Monday night: ") +
        "<strong>" +
        info.line.replace(/^Tonight: |^Next pickup Tue: /, "") +
        "</strong></p>" +
        "<p class=\"notes-when\">Anchor: Mon Oct 12 night = trash only (Tue Oct 13 pickup); Mon Oct 19 night = trash + recycling (Tue Oct 20 pickup); then alternating.</p></div>";
      global.openModal("Trash & recycling", "Tigard / kitchen reminder", html);
    },

    init: function () {
      const chip = document.getElementById("trash-chip");
      if (chip && !chip._trashBound) {
        chip._trashBound = true;
        chip.addEventListener("click", () => this.openModal());
      }
      this.renderChip();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.renderChip(), 60 * 1000);
    },
  };

  global.DashboardPlugins = global.DashboardPlugins || {};
  global.DashboardPlugins.trash = TrashPlugin;
})(typeof window !== "undefined" ? window : globalThis);

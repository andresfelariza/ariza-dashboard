/**
 * DashboardPlugins.weather — Open-Meteo forecast for Tigard, OR (ZIP 97223).
 * Free API, no key. Fahrenheit, America/Los_Angeles. Refresh ~30 min.
 */
(function (global) {
  "use strict";

  const CFG = {
    name: "weather",
    lat: 45.44,
    lon: -122.77,
    label: "Tigard",
    timezone: "America/Los_Angeles",
    refreshMs: 30 * 60 * 1000,
    hourlyHours: 12,
  };

  // WMO Weather interpretation codes → emoji + short label
  function codeInfo(code) {
    const c = Number(code);
    if (c === 0) return { icon: "☀️", label: "Clear" };
    if (c === 1) return { icon: "🌤", label: "Mostly clear" };
    if (c === 2) return { icon: "⛅", label: "Partly cloudy" };
    if (c === 3) return { icon: "☁", label: "Overcast" };
    if (c === 45 || c === 48) return { icon: "🌫", label: "Fog" };
    if (c >= 51 && c <= 55) return { icon: "🌦", label: "Drizzle" };
    if (c >= 56 && c <= 57) return { icon: "🌧", label: "Freezing drizzle" };
    if (c >= 61 && c <= 65) return { icon: "🌧", label: "Rain" };
    if (c >= 66 && c <= 67) return { icon: "🌧", label: "Freezing rain" };
    if (c >= 71 && c <= 77) return { icon: "❄", label: "Snow" };
    if (c >= 80 && c <= 82) return { icon: "🌦", label: "Showers" };
    if (c >= 85 && c <= 86) return { icon: "🌨", label: "Snow showers" };
    if (c === 95) return { icon: "⛈", label: "Thunderstorm" };
    if (c >= 96 && c <= 99) return { icon: "⛈", label: "T-storm / hail" };
    return { icon: "☁", label: "—" };
  }

  function roundTemp(t) {
    if (t == null || Number.isNaN(Number(t))) return "—";
    return String(Math.round(Number(t)));
  }

  function formatHour(iso) {
    try {
      const d = new Date(iso);
      return new Intl.DateTimeFormat("en-US", {
        timeZone: CFG.timezone,
        hour: "numeric",
        hour12: true,
      }).format(d);
    } catch (e) {
      return iso;
    }
  }

  function formatWeekday(isoDate) {
    try {
      // daily times are YYYY-MM-DD
      const d = new Date(isoDate + "T12:00:00");
      return new Intl.DateTimeFormat("en-US", {
        timeZone: CFG.timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(d);
    } catch (e) {
      return isoDate;
    }
  }

  const apiUrl = () => {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(CFG.lat));
    u.searchParams.set("longitude", String(CFG.lon));
    u.searchParams.set("timezone", CFG.timezone);
    u.searchParams.set("temperature_unit", "fahrenheit");
    u.searchParams.set("forecast_days", "7");
    u.searchParams.set(
      "current",
      "temperature_2m,weather_code,apparent_temperature,precipitation"
    );
    u.searchParams.set(
      "hourly",
      "temperature_2m,weather_code,precipitation_probability"
    );
    u.searchParams.set(
      "daily",
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    );
    return u.toString();
  };

  const WeatherPlugin = {
    id: CFG.name,
    config: CFG,
    data: null,
    timer: null,
    offline: false,

    init: function () {
      const chip = document.getElementById("weather-chip");
      if (chip) {
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.openModal();
        });
        chip.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.openModal();
          }
        });
      }
      this.refresh();
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.refresh(), CFG.refreshMs);
    },

    refresh: async function () {
      try {
        const res = await fetch(apiUrl(), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        this.data = await res.json();
        this.offline = false;
        this.renderChip();
        this.renderPhotoOverlay();
      } catch (e) {
        console.warn("[weather] fetch failed", e);
        this.offline = true;
        this.renderChip();
        this.renderPhotoOverlay();
      }
    },

    renderChip: function () {
      const chip = document.getElementById("weather-chip");
      if (!chip) return;
      const iconEl = chip.querySelector(".weather-icon");
      const tempEl = chip.querySelector(".weather-temp");
      const condEl = chip.querySelector(".weather-cond");
      const rangeEl = chip.querySelector(".weather-range");
      if (!this.data || !this.data.current) {
        if (iconEl) iconEl.textContent = "☁";
        if (tempEl) tempEl.textContent = this.offline ? "Offline" : "…";
        if (condEl) condEl.textContent = "";
        if (rangeEl) rangeEl.textContent = "";
        chip.classList.toggle("is-offline", !!this.offline);
        return;
      }
      const cur = this.data.current;
      const info = codeInfo(cur.weather_code);
      const hi = this.data.daily && this.data.daily.temperature_2m_max
        ? this.data.daily.temperature_2m_max[0]
        : null;
      const lo = this.data.daily && this.data.daily.temperature_2m_min
        ? this.data.daily.temperature_2m_min[0]
        : null;
      if (iconEl) iconEl.textContent = info.icon;
      if (tempEl) tempEl.textContent = roundTemp(cur.temperature_2m) + "°";
      if (condEl) condEl.textContent = info.label;
      if (rangeEl) {
        rangeEl.textContent =
          hi != null && lo != null
            ? "H " + roundTemp(hi) + "° · L " + roundTemp(lo) + "°"
            : "";
      }
      chip.classList.remove("is-offline");
      chip.setAttribute(
        "aria-label",
        "Weather " +
          roundTemp(cur.temperature_2m) +
          " degrees, " +
          info.label +
          ". Tap for forecast."
      );
    },

    renderPhotoOverlay: function () {
      const el = document.getElementById("photo-weather");
      if (!el) return;
      if (!this.data || !this.data.current) {
        el.textContent = "";
        el.hidden = true;
        return;
      }
      const cur = this.data.current;
      const info = codeInfo(cur.weather_code);
      el.textContent = info.icon + " " + roundTemp(cur.temperature_2m) + "°";
      el.hidden = false;
    },

    buildModalHtml: function () {
      if (!this.data || !this.data.current) {
        return (
          '<p class="weather-offline">' +
          (this.offline
            ? "Weather unavailable (offline or network error). Will retry automatically."
            : "Loading weather…") +
          "</p>"
        );
      }
      const cur = this.data.current;
      const info = codeInfo(cur.weather_code);
      const daily = this.data.daily || {};
      const hourly = this.data.hourly || {};

      let html = "";
      html +=
        '<div class="weather-now">' +
        '<div class="weather-now-icon">' +
        info.icon +
        "</div>" +
        '<div class="weather-now-main">' +
        '<div class="weather-now-temp">' +
        roundTemp(cur.temperature_2m) +
        "°</div>" +
        '<div class="weather-now-cond">' +
        info.label +
        "</div>" +
        '<div class="weather-now-feel">Feels like ' +
        roundTemp(cur.apparent_temperature) +
        "° · " +
        CFG.label +
        "</div>" +
        "</div></div>";

      // Next ~12 hours from "now"
      const times = hourly.time || [];
      const temps = hourly.temperature_2m || [];
      const codes = hourly.weather_code || [];
      const pops = hourly.precipitation_probability || [];
      const now = Date.now();
      let start = 0;
      for (let i = 0; i < times.length; i++) {
        if (new Date(times[i]).getTime() >= now - 30 * 60 * 1000) {
          start = i;
          break;
        }
      }
      const end = Math.min(start + CFG.hourlyHours, times.length);
      html += '<div class="modal-section"><div class="modal-label">Next hours</div>';
      html += '<div class="weather-hourly">';
      for (let i = start; i < end; i++) {
        const hi = codeInfo(codes[i]);
        const pop = pops[i] != null ? pops[i] + "%" : "—";
        html +=
          '<div class="weather-hour">' +
          '<div class="wh-time">' +
          formatHour(times[i]) +
          "</div>" +
          '<div class="wh-icon">' +
          hi.icon +
          "</div>" +
          '<div class="wh-temp">' +
          roundTemp(temps[i]) +
          "°</div>" +
          '<div class="wh-pop">' +
          pop +
          "</div>" +
          "</div>";
      }
      html += "</div></div>";

      html += '<div class="modal-section"><div class="modal-label">7-day forecast</div>';
      html += '<div class="weather-daily">';
      const days = daily.time || [];
      for (let i = 0; i < days.length; i++) {
        const di = codeInfo(daily.weather_code[i]);
        const pop =
          daily.precipitation_probability_max &&
          daily.precipitation_probability_max[i] != null
            ? daily.precipitation_probability_max[i] + "%"
            : "—";
        html +=
          '<div class="weather-day-row">' +
          '<div class="wd-name">' +
          (i === 0 ? "Today" : formatWeekday(days[i])) +
          "</div>" +
          '<div class="wd-icon">' +
          di.icon +
          "</div>" +
          '<div class="wd-hi">' +
          roundTemp(daily.temperature_2m_max[i]) +
          "°</div>" +
          '<div class="wd-lo">' +
          roundTemp(daily.temperature_2m_min[i]) +
          "°</div>" +
          '<div class="wd-pop">' +
          pop +
          "</div>" +
          "</div>";
      }
      html += "</div></div>";
      html +=
        '<p class="weather-source">Tigard · Open-Meteo · updates every 30 min</p>';
      return html;
    },

    openModal: function () {
      if (typeof global.openModal !== "function") {
        console.warn("[weather] openModal missing");
        return;
      }
      global.openModal(
        "Weather",
        CFG.label + ", OR",
        this.buildModalHtml()
      );
      // Refresh chip data when opening if we have none
      if (!this.data) this.refresh();
    },
  };

  global.DashboardPlugins = global.DashboardPlugins || {};
  global.DashboardPlugins.weather = WeatherPlugin;
})(window);

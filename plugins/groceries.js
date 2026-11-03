/**
 * DashboardPlugins.groceries — shared encrypted grocery list.
 *
 * Modes:
 *  - local: localStorage only (default when FIREBASE_CONFIG is null) — current kitchen behavior
 *  - firebase: Firestore realtime + AES-GCM payload (key = dashboard photo key from password)
 *
 * Backend never sees plaintext item names or check state when firebase mode is on.
 */
(function (global) {
  "use strict";

  const NS = "DashboardPlugins";
  const LOCAL_PREFIX = "ariza-grocery-v2:";
  const LEGACY_CHECKS_PREFIX = "ariza-grocery-checks:";

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let s = "";
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }
  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "i-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** Flatten seed GROCERIES object into item records. */
  function seedFromWeekly(GROCERIES) {
    const items = [];
    if (!GROCERIES || !GROCERIES.stores) return { weekKey: "unknown", items: [] };
    GROCERIES.stores.forEach((store, si) => {
      (store.groups || []).forEach((g, gi) => {
        (g.items || []).forEach((text, ii) => {
          items.push({
            id: "seed-" + si + "-" + gi + "-" + ii,
            text: String(text),
            store: store.name || "",
            category: g.name || "",
            checked: false,
            source: "seed",
          });
        });
      });
    });
    return { weekKey: GROCERIES.weekKey || "unknown", items: items, rev: 1 };
  }

  function migrateLegacyChecks(state, GROCERIES) {
    try {
      const raw = localStorage.getItem(LEGACY_CHECKS_PREFIX + (GROCERIES && GROCERIES.weekKey));
      if (!raw) return state;
      const checks = JSON.parse(raw || "{}");
      state.items.forEach((it) => {
        const m = /^seed-(\d+)-(\d+)-(\d+)$/.exec(it.id);
        if (!m) return;
        const key = m[1] + "-" + m[2] + "-" + m[3];
        if (checks[key]) it.checked = true;
      });
    } catch (e) {}
    return state;
  }

  const GroceriesPlugin = {
    id: "groceries",
    mode: "local", // local | firebase
    state: null,
    key: null, // CryptoKey
    unsub: null,
    db: null,
    ready: false,
    listeners: [],
    _writeTimer: null,
    _seed: null,

    onChange: function (fn) {
      this.listeners.push(fn);
      return () => {
        this.listeners = this.listeners.filter((f) => f !== fn);
      };
    },
    _emit: function () {
      const snap = this.getState();
      this.listeners.forEach((fn) => {
        try { fn(snap); } catch (e) { console.warn("[groceries] listener", e); }
      });
    },

    getState: function () {
      return this.state
        ? JSON.parse(JSON.stringify(this.state))
        : { weekKey: "unknown", items: [], rev: 0 };
    },

    localKey: function () {
      const wk = (this.state && this.state.weekKey) || (this._seed && this._seed.weekKey) || "default";
      return LOCAL_PREFIX + wk;
    },

    saveLocal: function () {
      try {
        localStorage.setItem(this.localKey(), JSON.stringify(this.state));
      } catch (e) {
        console.warn("[groceries] local save failed", e);
      }
    },

    loadLocal: function (weekKey) {
      try {
        const raw = localStorage.getItem(LOCAL_PREFIX + weekKey);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return null;
    },

    /** Import AES key from dashboard photo key (derived from family password). */
    importKey: async function () {
      if (!global.__PHOTO_KEY_B64) return null;
      const raw = b64ToBytes(global.__PHOTO_KEY_B64);
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    },

    encryptState: async function (state) {
      if (!this.key) throw new Error("no crypto key");
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const pt = new TextEncoder().encode(JSON.stringify(state));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, this.key, pt);
      const out = new Uint8Array(nonce.length + ct.byteLength);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), nonce.length);
      return bytesToB64(out);
    },

    decryptState: async function (b64) {
      if (!this.key) throw new Error("no crypto key");
      const buf = b64ToBytes(b64);
      const nonce = buf.slice(0, 12);
      const ct = buf.slice(12);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, this.key, ct);
      return JSON.parse(new TextDecoder().decode(pt));
    },

    init: async function (opts) {
      opts = opts || {};
      const GROCERIES = opts.GROCERIES || global.GROCERIES;
      if (!GROCERIES) {
        console.warn("[groceries] GROCERIES seed missing");
        return;
      }
      this._seed = seedFromWeekly(GROCERIES);
      this.key = await this.importKey();

      // Prefer local v2 state; else seed + migrate legacy checks
      let local = this.loadLocal(this._seed.weekKey);
      if (!local) {
        local = migrateLegacyChecks(this._seed, GROCERIES);
      } else if (local.weekKey !== this._seed.weekKey) {
        // New week published in HTML — start from seed, keep unchecked extras? replace list.
        local = migrateLegacyChecks(this._seed, GROCERIES);
      }
      this.state = local;
      this.saveLocal();
      this.ready = true;
      this._emit();

      const cfg = global.FIREBASE_CONFIG;
      const listId = global.GROCERY_LIST_ID;
      if (cfg && listId && cfg.projectId && !String(cfg.apiKey || "").includes("PASTE")) {
        try {
          await this._initFirebase(cfg, listId);
        } catch (e) {
          console.warn("[groceries] firebase init failed — staying local", e);
          this.mode = "local";
        }
      } else {
        this.mode = "local";
      }

      // Expose UI hook used by dashboard
      global.showGrocery = () => this.openModal();
    },

    _loadFirebaseSdk: function () {
      return new Promise((resolve, reject) => {
        if (global.firebase && global.firebase.firestore) {
          resolve();
          return;
        }
        const add = (src) =>
          new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = src;
            s.async = true;
            s.onload = res;
            s.onerror = () => rej(new Error("load " + src));
            document.head.appendChild(s);
          });
        add("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js")
          .then(() =>
            add("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js")
          )
          .then(() =>
            add("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js")
          )
          .then(resolve)
          .catch(reject);
      });
    },

    _initFirebase: async function (cfg, listId) {
      if (!this.key) {
        console.warn("[groceries] no __PHOTO_KEY_B64 — cannot E2E encrypt; staying local");
        this.mode = "local";
        return;
      }
      await this._loadFirebaseSdk();
      if (!global.firebase.apps.length) global.firebase.initializeApp(cfg);
      await global.firebase.auth().signInAnonymously();
      this.db = global.firebase.firestore();
      this.listRef = this.db.collection("groceryLists").doc(listId);
      this.mode = "firebase";

      // Realtime listener
      this.unsub = this.listRef.onSnapshot(
        async (snap) => {
          if (!snap.exists) {
            // First device seeds the encrypted doc
            await this._pushRemote();
            return;
          }
          const data = snap.data() || {};
          if (!data.ciphertext) return;
          try {
            const remote = await this.decryptState(data.ciphertext);
            // Merge by rev / updatedAt
            if (!this.state || (remote.rev || 0) > (this.state.rev || 0)) {
              this.state = remote;
              this.saveLocal();
              this._emit();
              if (document.getElementById("modal")?.classList.contains("open") &&
                  document.getElementById("modal-title")?.textContent === "Grocery list") {
                this.openModal(); // refresh open modal
              }
            }
          } catch (e) {
            console.warn("[groceries] decrypt remote failed (wrong password/key?)", e);
          }
        },
        (err) => console.warn("[groceries] snapshot error", err)
      );
    },

    _pushRemote: async function () {
      if (this.mode !== "firebase" || !this.listRef || !this.key) return;
      try {
        this.state.rev = (this.state.rev || 0) + 1;
        this.state.updatedAt = Date.now();
        const ciphertext = await this.encryptState(this.state);
        await this.listRef.set(
          {
            ciphertext: ciphertext,
            weekKey: this.state.weekKey,
            rev: this.state.rev,
            updatedAt: global.firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        this.saveLocal();
      } catch (e) {
        console.warn("[groceries] push failed — queued locally", e);
        this.saveLocal();
      }
    },

    _schedulePush: function () {
      this.saveLocal();
      this._emit();
      if (this.mode !== "firebase") return;
      clearTimeout(this._writeTimer);
      this._writeTimer = setTimeout(() => this._pushRemote(), 250);
    },

    toggle: function (id) {
      const it = this.state.items.find((x) => x.id === id);
      if (!it) return;
      it.checked = !it.checked;
      this._schedulePush();
    },

    addItem: function (text, store) {
      text = String(text || "").trim();
      if (!text) return null;
      const item = {
        id: uid(),
        text: text,
        store: store || "New Seasons / Safeway",
        category: "Added",
        checked: false,
        source: "user",
      };
      this.state.items.push(item);
      this._schedulePush();
      return item;
    },

    clearChecked: function () {
      this.state.items.forEach((it) => {
        it.checked = false;
      });
      this._schedulePush();
    },

    /** Replace week seed (Saturday meal-plan routine / publish). Merges user-added unchecked extras. */
    replaceWeek: function (GROCERIES) {
      const seeded = seedFromWeekly(GROCERIES);
      const extras = (this.state && this.state.items) || [];
      const keep = extras.filter(
        (it) => it.source === "user" && !it.checked && it.text
      );
      // Avoid dupes by text+store
      const have = new Set(seeded.items.map((i) => i.store + "\0" + i.text));
      keep.forEach((it) => {
        const k = it.store + "\0" + it.text;
        if (!have.has(k)) seeded.items.push(it);
      });
      seeded.rev = (this.state && this.state.rev ? this.state.rev : 0) + 1;
      this.state = seeded;
      this._seed = seedFromWeekly(GROCERIES);
      this._schedulePush();
    },

    esc: function (s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },

    openModal: function () {
      if (typeof global.openModal !== "function") return;
      const st = this.getState();
      const byStore = {};
      st.items.forEach((it) => {
        const sn = it.store || "Other";
        if (!byStore[sn]) byStore[sn] = {};
        const cat = it.category || "";
        if (!byStore[sn][cat]) byStore[sn][cat] = [];
        byStore[sn][cat].push(it);
      });

      let html = "";
      const modeNote =
        this.mode === "firebase"
          ? '<p class="grocery-sync-note">Live sync on · encrypted</p>'
          : '<p class="grocery-sync-note">This device only · connect Firebase for family sync</p>';
      html += modeNote;

      Object.keys(byStore).forEach((storeName) => {
        html += '<div class="grocery-store"><h3>' + this.esc(storeName) + "</h3>";
        const cats = byStore[storeName];
        Object.keys(cats).forEach((cat) => {
          if (cat) html += '<div class="grocery-cat">' + this.esc(cat) + "</div>";
          cats[cat].forEach((it) => {
            html +=
              '<button type="button" class="grocery-item' +
              (it.checked ? " checked" : "") +
              '" data-gid="' +
              this.esc(it.id) +
              '">' +
              '<span class="box" aria-hidden="true"></span><span>' +
              this.esc(it.text) +
              "</span></button>";
          });
        });
        html += "</div>";
      });

      html +=
        '<div class="grocery-add-row">' +
        '<input type="text" id="grocery-add-input" class="grocery-add-input" placeholder="Add item…" maxlength="80" autocomplete="off" />' +
        '<button type="button" class="btn btn-accent" id="grocery-add-btn">Add</button>' +
        "</div>";
      html +=
        '<div class="modal-footer-actions">' +
        '<button type="button" class="btn btn-clear" id="grocery-clear">Clear checks</button>' +
        "</div>";

      global.openModal(
        "Grocery list",
        "Costco · New Seasons / Safeway",
        html
      );

      const body = document.getElementById("modal-body");
      if (!body) return;
      body.querySelectorAll(".grocery-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-gid");
          this.toggle(id);
          btn.classList.toggle("checked", !!(this.state.items.find((x) => x.id === id) || {}).checked);
        });
      });
      const clearBtn = document.getElementById("grocery-clear");
      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          this.clearChecked();
          this.openModal();
        });
      }
      const addBtn = document.getElementById("grocery-add-btn");
      const addInput = document.getElementById("grocery-add-input");
      const doAdd = () => {
        if (!addInput) return;
        const item = this.addItem(addInput.value);
        if (item) this.openModal();
      };
      if (addBtn) addBtn.addEventListener("click", doAdd);
      if (addInput) {
        addInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            doAdd();
          }
        });
        setTimeout(() => addInput.focus(), 50);
      }
    },
  };

  // ---- Test/mock helpers (used by scripts/test_groceries_mock.mjs via jsdom-less path) ----
  GroceriesPlugin._seedFromWeekly = seedFromWeekly;
  GroceriesPlugin._testing = {
    encryptRoundTrip: async function (plugin, obj) {
      const b64 = await plugin.encryptState(obj);
      return plugin.decryptState(b64);
    },
  };

  global[NS] = global[NS] || {};
  global[NS].groceries = GroceriesPlugin;
})(typeof window !== "undefined" ? window : globalThis);

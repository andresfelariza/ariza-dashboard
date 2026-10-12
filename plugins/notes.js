/**
 * DashboardPlugins.notes — shared encrypted family notes board.
 * Firestore: groceryLists/{NOTES_LIST_ID} (same rules as groceries — no rule change).
 */
(function (global) {
  "use strict";

  const NS = "DashboardPlugins";
  const LOCAL_KEY = "ariza-notes-v1";
  function authorsList() {
    const base = Array.isArray(global.FAMILY_NOTE_AUTHORS) ? global.FAMILY_NOTE_AUTHORS.slice() : [];
    if (!base.includes("")) base.push("");
    return base;
  }

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
    return "n-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatWhen(ts) {
    try {
      const d = new Date(ts);
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    } catch (e) {
      return "";
    }
  }

  const NotesPlugin = {
    id: "notes",
    mode: "local",
    state: { notes: [], rev: 0 },
    key: null,
    unsub: null,
    listRef: null,
    ready: false,
    _writeTimer: null,

    activeNotes: function () {
      return (this.state.notes || [])
        .filter((n) => !n.done)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    importKey: async function () {
      if (!global.__PHOTO_KEY_B64) return null;
      return crypto.subtle.importKey(
        "raw",
        b64ToBytes(global.__PHOTO_KEY_B64),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
    },

    encryptState: async function (state) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const pt = new TextEncoder().encode(JSON.stringify(state));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, this.key, pt);
      const out = new Uint8Array(nonce.length + ct.byteLength);
      out.set(nonce, 0);
      out.set(new Uint8Array(ct), nonce.length);
      return bytesToB64(out);
    },

    decryptState: async function (b64) {
      const buf = b64ToBytes(b64);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf.slice(0, 12) },
        this.key,
        buf.slice(12)
      );
      return JSON.parse(new TextDecoder().decode(pt));
    },

    saveLocal: function () {
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(this.state));
      } catch (e) {}
    },

    loadLocal: function () {
      try {
        const raw = localStorage.getItem(LOCAL_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return { notes: [], rev: 0 };
    },

    _loadFirebaseSdk: function () {
      if (global.firebase && global.firebase.firestore) return Promise.resolve();
      if (global.__firebaseSdkReady) return global.__firebaseSdkReady;
      global.__firebaseSdkReady = new Promise((resolve, reject) => {
        const add = (src) =>
          new Promise((res, rej) => {
            if (document.querySelector('script[src="' + src + '"]')) {
              // wait briefly for prior loader
              const t0 = Date.now();
              const wait = () => {
                if (global.firebase && global.firebase.firestore) return res();
                if (Date.now() - t0 > 8000) return rej(new Error("timeout " + src));
                setTimeout(wait, 50);
              };
              return wait();
            }
            const s = document.createElement("script");
            s.src = src;
            s.async = true;
            s.onload = res;
            s.onerror = () => rej(new Error("load " + src));
            document.head.appendChild(s);
          });
        add("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js")
          .then(() => add("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"))
          .then(() => add("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js"))
          .then(resolve)
          .catch(reject);
      });
      return global.__firebaseSdkReady;
    },

    init: async function () {
      this.key = await this.importKey();
      this.state = this.loadLocal();
      if (!this.state.notes) this.state.notes = [];
      this.ready = true;
      this.renderPreview();
      this._bindPreviewChrome();

      const cfg = global.FIREBASE_CONFIG;
      const listId = global.NOTES_LIST_ID;
      if (cfg && listId && cfg.projectId && !String(cfg.apiKey || "").includes("PASTE") && this.key) {
        try {
          await this._initFirebase(cfg, listId);
        } catch (e) {
          console.warn("[notes] firebase init failed — local only", e);
          this.mode = "local";
        }
      } else {
        this.mode = "local";
      }
    },

    _initFirebase: async function (cfg, listId) {
      await this._loadFirebaseSdk();
      if (!global.firebase.apps.length) global.firebase.initializeApp(cfg);
      if (!global.firebase.auth().currentUser) {
        await global.firebase.auth().signInAnonymously();
      }
      this.listRef = global.firebase.firestore().collection("groceryLists").doc(listId);
      this.mode = "firebase";
      this.unsub = this.listRef.onSnapshot(
        async (snap) => {
          if (!snap.exists) {
            await this._pushRemote();
            return;
          }
          const data = snap.data() || {};
          if (!data.ciphertext) return;
          try {
            const remote = await this.decryptState(data.ciphertext);
            if (!this.state || (remote.rev || 0) >= (this.state.rev || 0)) {
              this.state = remote;
              if (!this.state.notes) this.state.notes = [];
              this.saveLocal();
              this.renderPreview();
              if (
                document.getElementById("modal")?.classList.contains("open") &&
                document.getElementById("modal-title")?.textContent === "Family notes"
              ) {
                this.openModal();
              }
            }
          } catch (e) {
            console.warn("[notes] decrypt failed", e);
          }
        },
        (err) => console.warn("[notes] snapshot", err)
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
            weekKey: "notes",
            rev: this.state.rev,
            updatedAt: global.firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        this.saveLocal();
      } catch (e) {
        console.warn("[notes] push failed", e);
        this.saveLocal();
      }
    },

    _schedulePush: function () {
      this.saveLocal();
      this.renderPreview();
      if (this.mode !== "firebase") return;
      clearTimeout(this._writeTimer);
      this._writeTimer = setTimeout(() => this._pushRemote(), 250);
    },

    addNote: function (text, author) {
      text = String(text || "").trim();
      if (!text) return null;
      if (text.length > 280) text = text.slice(0, 280);
      const note = {
        id: uid(),
        text: text,
        author: authorsList().includes(author) ? author : "",
        createdAt: Date.now(),
        done: false,
      };
      this.state.notes.push(note);
      this._schedulePush();
      return note;
    },

    markDone: function (id) {
      const n = this.state.notes.find((x) => x.id === id);
      if (!n) return;
      n.done = true;
      this._schedulePush();
    },

    removeNote: function (id) {
      this.state.notes = this.state.notes.filter((x) => x.id !== id);
      this._schedulePush();
    },

    renderPreview: function () {
      const box = document.getElementById("notes-preview-list");
      if (!box) return;
      const top = this.activeNotes().slice(0, 3);
      if (!top.length) {
        box.innerHTML = '<div class="notes-empty">No notes yet — tap to add one</div>';
        return;
      }
      box.innerHTML = top
        .map(
          (n) =>
            '<div class="notes-preview-item">' +
            (n.author ? '<span class="notes-author">' + esc(n.author) + "</span> " : "") +
            '<span class="notes-text">' +
            esc(n.text) +
            "</span>" +
            '<span class="notes-when">' +
            esc(formatWhen(n.createdAt)) +
            "</span></div>"
        )
        .join("");
    },

    _bindPreviewChrome: function () {
      const open = () => this.openModal();
      const panel = document.getElementById("notes-preview");
      const btn = document.getElementById("btn-notes");
      if (panel && !panel._notesBound) {
        panel._notesBound = true;
        panel.addEventListener("click", (ev) => {
          if (ev.target.closest("button")) return;
          open();
        });
      }
      if (btn && !btn._notesBound) {
        btn._notesBound = true;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          open();
        });
      }
    },

    openModal: function () {
      if (typeof global.openModal !== "function") return;
      const active = this.activeNotes();
      const done = (this.state.notes || [])
        .filter((n) => n.done)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 8);

      let html = "";
      html +=
        '<div class="notes-compose">' +
        '<div class="notes-author-row" role="group" aria-label="Who is posting">' +
        authorsList().filter(Boolean)
          .map(
            (a) =>
              '<button type="button" class="notes-author-btn" data-author="' +
              esc(a) +
              '">' +
              esc(a) +
              "</button>"
          )
          .join("") +
        '<button type="button" class="notes-author-btn" data-author="">Anon</button>' +
        "</div>" +
        '<textarea id="notes-input" class="notes-input" maxlength="280" rows="3" placeholder="Write a short note…"></textarea>' +
        '<div class="notes-compose-actions">' +
        '<button type="button" class="btn btn-accent" id="notes-post">Post note</button>' +
        (this.mode === "firebase"
          ? '<span class="notes-sync">Live · encrypted</span>'
          : '<span class="notes-sync">This device only</span>') +
        "</div></div>";

      html += '<div class="notes-list">';
      if (!active.length) html += '<div class="notes-empty">No open notes</div>';
      active.forEach((n) => {
        html +=
          '<div class="notes-item" data-nid="' +
          esc(n.id) +
          '">' +
          '<div class="notes-item-main">' +
          (n.author ? '<div class="notes-author">' + esc(n.author) + "</div>" : "") +
          '<div class="notes-text">' +
          esc(n.text) +
          "</div>" +
          '<div class="notes-when">' +
          esc(formatWhen(n.createdAt)) +
          "</div></div>" +
          '<div class="notes-item-actions">' +
          '<button type="button" class="btn notes-done-btn" data-act="done">Done</button>' +
          '<button type="button" class="btn notes-del-btn" data-act="del">Delete</button>' +
          "</div></div>";
      });
      html += "</div>";

      if (done.length) {
        html += '<div class="notes-done-label">Recently done</div><div class="notes-list notes-done-list">';
        done.forEach((n) => {
          html +=
            '<div class="notes-item done" data-nid="' +
            esc(n.id) +
            '">' +
            '<div class="notes-item-main"><div class="notes-text">' +
            esc(n.text) +
            "</div>" +
            '<div class="notes-when">' +
            esc(n.author ? n.author + " · " : "") +
            esc(formatWhen(n.createdAt)) +
            "</div></div>" +
            '<button type="button" class="btn notes-del-btn" data-act="del">Delete</button></div>';
        });
        html += "</div>";
      }

      global.openModal("Family notes", "Shared board for the house", html);

      let author = "";
      try {
        author = localStorage.getItem("ariza-notes-author") || "";
      } catch (e) {}
      const body = document.getElementById("modal-body");
      if (!body) return;
      const markAuthor = () => {
        body.querySelectorAll(".notes-author-btn").forEach((b) => {
          b.classList.toggle("selected", (b.getAttribute("data-author") || "") === author);
        });
      };
      markAuthor();
      body.querySelectorAll(".notes-author-btn").forEach((b) => {
        b.addEventListener("click", () => {
          author = b.getAttribute("data-author") || "";
          try {
            localStorage.setItem("ariza-notes-author", author);
          } catch (e) {}
          markAuthor();
        });
      });
      const post = () => {
        const ta = document.getElementById("notes-input");
        const text = ta && ta.value;
        if (this.addNote(text, author)) this.openModal();
      };
      const postBtn = document.getElementById("notes-post");
      if (postBtn) postBtn.addEventListener("click", post);
      const ta = document.getElementById("notes-input");
      if (ta) {
        ta.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            post();
          }
        });
        setTimeout(() => ta.focus(), 40);
      }
      body.querySelectorAll(".notes-item").forEach((row) => {
        const id = row.getAttribute("data-nid");
        row.querySelectorAll("[data-act]").forEach((btn) => {
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const act = btn.getAttribute("data-act");
            if (act === "done") this.markDone(id);
            if (act === "del") this.removeNote(id);
            this.openModal();
          });
        });
      });
    },
  };

  global[NS] = global[NS] || {};
  global[NS].notes = NotesPlugin;
})(typeof window !== "undefined" ? window : globalThis);

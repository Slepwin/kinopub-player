"use strict";

/* ------------------------------------------------------------------ dom --- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

/* ----------------------------------------------------------- formatting --- */

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function fmtDate(unixSec) {
  const d = new Date(unixSec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// "1080p" -> 1080; used for natural quality sorting
function qualityRank(q) {
  const n = parseInt(q, 10);
  return Number.isNaN(n) ? 0 : n;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* --------------------------------------------------------------- toasts --- */

function toast(message, { error = false, ms = 3500 } = {}) {
  const node = el("div", { class: `toast${error ? " error" : ""}`, text: message });
  $("#toast-host").append(node);
  setTimeout(() => node.remove(), ms);
}

/* -------------------------------------------------------------- dialogs --- */

const Dialogs = {
  _stack: [],

  _open(dlg, { onClose } = {}) {
    $("#dim").classList.remove("hidden");
    $("#dialog-host").append(dlg);
    this._stack.push({ dlg, onClose });
    return dlg;
  },

  close(result) {
    const top = this._stack.pop();
    if (!top) return;
    top.dlg.remove();
    if (this._stack.length === 0) $("#dim").classList.add("hidden");
    if (top.onClose) top.onClose(result);
  },

  closeAll() {
    while (this._stack.length) this.close(undefined);
  },

  /**
   * Builds a classic dialog window. bodyNodes: Node|Node[].
   * buttons: [{label, primary, value}] — resolves the promise with `value`.
   */
  show({ title, bodyNodes, buttons, selectable = false, width }) {
    return new Promise((resolve) => {
      const body = el("div", { class: `dialog-body${selectable ? " selectable" : ""}` }, bodyNodes);
      const btnRow = el(
        "div",
        { class: "dialog-buttons" },
        (buttons || [{ label: "OK", primary: true, value: true }]).map((b) =>
          el("button", {
            class: `btn${b.primary ? " primary" : ""}`,
            text: b.label,
            onclick: () => this.close(b.value),
          })
        )
      );
      const dlg = el("div", { class: "dialog" }, [
        el("div", { class: "dialog-title" }, [
          el("span", { text: title }),
          el("span", { class: "dlg-close", text: "✕", onclick: () => this.close(undefined) }),
        ]),
        body,
        btnRow,
      ]);
      if (width) dlg.style.minWidth = `${width}px`;
      this._open(dlg, { onClose: resolve });
    });
  },

  alert(title, message) {
    return this.show({
      title,
      bodyNodes: el("div", { html: message }),
      selectable: true,
    });
  },

  confirm(title, message) {
    return this.show({
      title,
      bodyNodes: el("div", { text: message }),
      buttons: [
        { label: "Да", primary: true, value: true },
        { label: "Нет", value: false },
      ],
    }).then((v) => Boolean(v));
  },

  /** Text input dialog; resolves with string or null. */
  input(title, { placeholder = "", value = "" } = {}) {
    return new Promise((resolve) => {
      const inp = el("input", { type: "text", placeholder });
      inp.value = value;
      const done = (ok) => this.close(ok ? inp.value.trim() : null);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
        e.stopPropagation();
      });
      const dlg = el("div", { class: "dialog" }, [
        el("div", { class: "dialog-title" }, [
          el("span", { text: title }),
          el("span", { class: "dlg-close", text: "✕", onclick: () => done(false) }),
        ]),
        el("div", { class: "dialog-body" }, inp),
        el("div", { class: "dialog-buttons" }, [
          el("button", { class: "btn primary", text: "OK", onclick: () => done(true) }),
          el("button", { class: "btn", text: "Отмена", onclick: () => done(false) }),
        ]),
      ]);
      this._open(dlg, { onClose: (v) => resolve(v === "" ? null : v) });
      setTimeout(() => inp.focus(), 0);
    });
  },

  /** Single-select list; options: [{label, value}]. Resolves value or null. */
  select(title, options) {
    return new Promise((resolve) => {
      const rows = options.map((o) =>
        el("div", {
          class: "opt-row",
          text: o.label,
          onclick: () => this.close(o.value),
        })
      );
      const dlg = el("div", { class: "dialog" }, [
        el("div", { class: "dialog-title" }, [
          el("span", { text: title }),
          el("span", { class: "dlg-close", text: "✕", onclick: () => this.close(null) }),
        ]),
        el("div", { class: "dialog-body" }, rows),
      ]);
      this._open(dlg, { onClose: (v) => resolve(v === undefined ? null : v) });
    });
  },

  /**
   * Multi-select checklist; options: [{label, value, checked}].
   * Resolves array of selected values, or null on cancel.
   */
  multiselect(title, options) {
    return new Promise((resolve) => {
      const boxes = options.map((o) => {
        const cb = el("input", { type: "checkbox" });
        cb.checked = Boolean(o.checked);
        cb._value = o.value;
        return el("label", { class: "opt-row" }, [cb, el("span", { text: o.label })]);
      });
      const done = (ok) =>
        this.close(
          ok ? boxes.map((b) => b.firstChild).filter((c) => c.checked).map((c) => c._value) : null
        );
      const dlg = el("div", { class: "dialog" }, [
        el("div", { class: "dialog-title" }, [
          el("span", { text: title }),
          el("span", { class: "dlg-close", text: "✕", onclick: () => done(false) }),
        ]),
        el("div", { class: "dialog-body" }, boxes),
        el("div", { class: "dialog-buttons" }, [
          el("button", { class: "btn primary", text: "OK", onclick: () => done(true) }),
          el("button", { class: "btn", text: "Отмена", onclick: () => done(false) }),
        ]),
      ]);
      this._open(dlg, { onClose: (v) => resolve(v === undefined ? null : v) });
    });
  },
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && Dialogs._stack.length) {
    e.stopPropagation();
    Dialogs.close(undefined);
  }
}, true);

/* --------------------------------------------------------- context menu --- */

const CtxMenu = {
  show(x, y, items) {
    this.hide();
    const menu = $("#ctx-menu");
    menu.innerHTML = "";
    for (const item of items) {
      if (item === "-") {
        menu.append(el("div", { class: "menu-sep" }));
        continue;
      }
      menu.append(
        el("div", {
          class: `menu-item${item.disabled ? " disabled" : ""}${item.checked ? " checked" : ""}`,
          onclick: (e) => {
            // an action may open another ctx menu; the click must not bubble to
            // the document handler that would immediately hide it
            e.stopPropagation();
            if (item.disabled) return;
            this.hide();
            item.action && item.action();
          },
        }, [el("span", { text: item.label }), item.hotkey ? el("span", { class: "hotkey", text: item.hotkey }) : null])
      );
    }
    menu.classList.remove("hidden");
    // keep on screen
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
  },

  hide() {
    $("#ctx-menu").classList.add("hidden");
  },
};

document.addEventListener("click", (e) => {
  if (!e.target.closest("#ctx-menu")) CtxMenu.hide();
});
window.addEventListener("blur", () => CtxMenu.hide());

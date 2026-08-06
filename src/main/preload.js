"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kp", {
  get: (endpoint, params) => ipcRenderer.invoke("api:get", endpoint, params),
  post: (endpoint, params) => ipcRenderer.invoke("api:post", endpoint, params),
  getItemsNoAnime: (endpoint, params) =>
    ipcRenderer.invoke("api:itemsNoAnime", endpoint, params),

  auth: {
    state: () => ipcRenderer.invoke("auth:state"),
    start: () => ipcRenderer.invoke("auth:start"),
    cancel: () => ipcRenderer.invoke("auth:cancel"),
    reset: () => ipcRenderer.invoke("auth:reset"),
  },

  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },

  history: {
    add: (title) => ipcRenderer.invoke("history:add", title),
    clear: () => ipcRenderer.invoke("history:clear"),
  },

  fetchSubtitles: (url) => ipcRenderer.invoke("subtitles:fetch", url),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  toggleFullscreen: (flag) => ipcRenderer.invoke("win:fullscreen", flag),
  isFullscreen: () => ipcRenderer.invoke("win:isFullscreen"),

  on: (channel, cb) => {
    const allowed = ["auth:code", "auth:success", "auth:error", "auth:required"];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (e, payload) => cb(payload));
  },
});

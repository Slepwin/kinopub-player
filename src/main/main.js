"use strict";

const { app, BrowserWindow, ipcMain, shell, session, net } = require("electron");
const path = require("path");
const { Store } = require("./store");
const { KinoPubApi } = require("./api");

let win = null;
let store = null;
let api = null;

function emitToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// "system" follows the OS proxy settings; "direct" forces direct connections.
function applyProxyMode() {
  session.defaultSession.setProxy({
    mode: store.get("use_system_proxy") ? "system" : "direct",
  });
}

function createWindow() {
  const bounds = store.get("window_bounds") || {};
  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 520,
    backgroundColor: "#1a1a1a",
    autoHideMenuBar: true, // in-page MPC-style menu bar is used instead
    title: "KinoPub Player",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The kino.pub CDN serves HLS manifests/segments without CORS headers;
      // the renderer (hls.js) must fetch them directly, so CORS is off.
      webSecurity: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.on("close", () => {
    store.set({ window_bounds: win.getBounds() });
  });

  // external links (e.g. verification_uri) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function registerIpc() {
  ipcMain.handle("api:get", (e, endpoint, params) => api.request(endpoint, params, "GET"));
  ipcMain.handle("api:post", (e, endpoint, params) => api.request(endpoint, params, "POST"));
  ipcMain.handle("api:itemsNoAnime", (e, endpoint, params) =>
    api.getItemsExcludeAnime(endpoint, params)
  );

  ipcMain.handle("auth:state", () => ({ authorized: api.isAuthorized }));
  ipcMain.handle("auth:start", () => {
    api.startDeviceFlow(); // async; progress arrives via auth:* events
    return true;
  });
  ipcMain.handle("auth:cancel", () => api.cancelDeviceFlow());
  ipcMain.handle("auth:reset", () => api.resetAuth());

  ipcMain.handle("settings:get", () => store.get());
  ipcMain.handle("settings:set", (e, patch) => {
    const result = store.set(patch);
    if ("use_system_proxy" in patch) applyProxyMode();
    return result;
  });

  ipcMain.handle("history:add", (e, title) => store.addSearchHistory(title));
  ipcMain.handle("history:clear", () => store.clearSearchHistory());

  ipcMain.handle("shell:openExternal", (e, url) => shell.openExternal(url));

  ipcMain.handle("win:fullscreen", (e, flag) => {
    win.setFullScreen(flag === undefined ? !win.isFullScreen() : Boolean(flag));
    return win.isFullScreen();
  });
  ipcMain.handle("win:isFullscreen", () => win.isFullScreen());

  // Fetches a subtitle file (srt) and returns its text — done in the main
  // process to avoid renderer mixed-content/charset issues.
  ipcMain.handle("subtitles:fetch", async (e, url) => {
    const doFetch = store.get("use_system_proxy") ? net.fetch : fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`subtitles HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // kino.pub subtitles are UTF-8
    return buf.toString("utf8");
  });
}

app.whenReady().then(() => {
  store = new Store(app.getPath("userData"));
  api = new KinoPubApi(store, emitToRenderer);

  // Some CDN endpoints reject unknown user agents — align with the add-on.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
    cb({ requestHeaders: details.requestHeaders });
  });

  applyProxyMode();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

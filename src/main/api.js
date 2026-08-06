"use strict";

const os = require("os");

// Same OAuth application as the Kodi add-on (kodi.kino.pub).
const CLIENT_ID = "xbmc";
const CLIENT_SECRET = "cgg3gtifu46urtfp2zp1nqtba0k2ezxh";
const API_URL = "https://api.srvkp.com/v1";
const OAUTH_DEVICE_URL = "https://api.srvkp.com/oauth2/device";
const OAUTH_TOKEN_URL = "https://api.srvkp.com/oauth2/token";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const TIMEOUT_MS = 60000;

class ApiError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.code = code;
    this.payload = payload;
  }
}

function formBody(data) {
  return new URLSearchParams(
    Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, String(v)])
    )
  ).toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class KinoPubApi {
  /**
   * @param {import('./store').Store} store
   * @param {(event: string, payload?: any) => void} emit - pushes events to renderer
   */
  constructor(store, emit) {
    this.store = store;
    this.emit = emit;
    this._deviceFlow = null; // {cancelled: bool}
    this._refreshing = null; // in-flight refresh promise
  }

  get isAuthorized() {
    return Boolean(this.store.get("access_token"));
  }

  // ---------------------------------------------------------------- OAuth ---

  async _oauthRequest(payload, url) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: formBody(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* non-JSON body */
    }
    if (res.status === 400 && data && data.error) return data; // caller inspects .error
    if (res.status === 429) {
      await sleep(3000);
      return this._oauthRequest(payload, url);
    }
    if (!res.ok) throw new ApiError(`OAuth HTTP ${res.status}`, res.status, data);
    return data;
  }

  /**
   * Starts the device-code flow. Emits:
   *   auth:code {user_code, verification_uri}  — show to the user
   *   auth:success                             — tokens obtained
   *   auth:error {message}
   * Polls until success, expiry or cancellation.
   */
  async startDeviceFlow() {
    this.cancelDeviceFlow();
    const flow = { cancelled: false };
    this._deviceFlow = flow;
    try {
      const resp = await this._oauthRequest(
        { grant_type: "device_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
        OAUTH_DEVICE_URL
      );
      if (resp.error) throw new ApiError(resp.error, 400, resp);
      const { code, user_code, verification_uri, interval, expires_in } = resp;
      this.emit("auth:code", { user_code, verification_uri });
      const deadline = Date.now() + (Number(expires_in) || 300) * 1000;
      while (!flow.cancelled && Date.now() < deadline) {
        const token = await this._oauthRequest(
          {
            grant_type: "device_token",
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
          },
          OAUTH_DEVICE_URL
        );
        if (flow.cancelled) return;
        if (token.error) {
          if (token.error === "authorization_pending") {
            await sleep((Number(interval) || 5) * 1000);
            continue;
          }
          if (["code_expired", "authorization_expired"].includes(token.error)) {
            // code expired — restart the flow with a fresh code
            return this.startDeviceFlow();
          }
          throw new ApiError(token.error, 400, token);
        }
        this._saveTokens(token);
        await this._notifyDevice();
        this.emit("auth:success");
        return;
      }
      if (!flow.cancelled) this.emit("auth:error", { message: "Время авторизации истекло" });
    } catch (e) {
      if (!flow.cancelled) this.emit("auth:error", { message: e.message });
    }
  }

  cancelDeviceFlow() {
    if (this._deviceFlow) this._deviceFlow.cancelled = true;
    this._deviceFlow = null;
  }

  _saveTokens(resp) {
    this.store.set({
      access_token: resp.access_token,
      refresh_token: resp.refresh_token,
      access_token_expire: Math.floor(Date.now() / 1000) + Number(resp.expires_in || 0),
    });
  }

  async _refreshToken() {
    // collapse concurrent refreshes into one request
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const refresh_token = this.store.get("refresh_token");
      if (!refresh_token) throw new ApiError("no refresh token", 401);
      const resp = await this._oauthRequest(
        {
          grant_type: "refresh_token",
          refresh_token,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        },
        OAUTH_TOKEN_URL
      );
      if (resp.error) {
        this.store.resetAuth();
        this.emit("auth:required");
        throw new ApiError(resp.error, 401, resp);
      }
      this._saveTokens(resp);
    })();
    try {
      await this._refreshing;
    } finally {
      this._refreshing = null;
    }
  }

  async ensureFreshToken() {
    if (!this.isAuthorized) return;
    const expire = Number(this.store.get("access_token_expire")) || 0;
    if (expire - 60 < Math.floor(Date.now() / 1000)) {
      try {
        await this._refreshToken();
      } catch (e) {
        /* auth:required already emitted */
      }
    }
  }

  async _notifyDevice() {
    try {
      await this.request("device/notify", {
        title: os.hostname(),
        hardware: os.arch(),
        software: "KinoPub Player (Electron)",
      }, "POST");
    } catch (e) {
      /* non-critical */
    }
  }

  resetAuth() {
    this.cancelDeviceFlow();
    this.store.resetAuth();
    this.emit("auth:required");
  }

  // ------------------------------------------------------------- API core ---

  /**
   * @param {string} endpoint e.g. "items/fresh"
   * @param {object} params query params (GET) or form body (POST)
   * @param {"GET"|"POST"} method
   */
  async request(endpoint, params = {}, method = "GET", _retries = { 401: 0, 429: 0 }) {
    await this.ensureFreshToken();
    const clean = Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
    );
    let url = `${API_URL}/${endpoint}`;
    const opts = {
      method,
      headers: {
        authorization: `Bearer ${this.store.get("access_token")}`,
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (method === "GET") {
      const qs = formBody(clean);
      if (qs) url += `?${qs}`;
    } else {
      opts.headers["content-type"] = "application/x-www-form-urlencoded";
      opts.body = formBody(clean);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new ApiError("kino.pub не отвечает", 0, { cause: String(e) });
    }

    if (res.status === 401) {
      if (_retries[401] >= 1) {
        this.store.resetAuth();
        this.emit("auth:required");
        throw new ApiError("Ошибка авторизации", 401);
      }
      _retries[401] += 1;
      try {
        await this._refreshToken();
      } catch (e) {
        this.emit("auth:required");
        throw new ApiError("Требуется авторизация", 401);
      }
      return this.request(endpoint, params, method, _retries);
    }
    if (res.status === 429) {
      if (_retries[429] >= 3) throw new ApiError("Слишком много запросов (429)", 429);
      _retries[429] += 1;
      await sleep(5000);
      return this.request(endpoint, params, method, _retries);
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* empty body */
    }
    if (data && data.status && data.status !== 200) {
      throw new ApiError(`Ошибка сервера: ${data.status}`, data.status, data);
    }
    if (!res.ok) throw new ApiError(`Ошибка сервера: ${res.status}`, res.status, data);
    return data || { status: 200 };
  }

  // -------------------------------------------------- anime-free listings ---

  static ANIME_GENRE_ID = 25;

  static isAnime(item) {
    return (item.genres || []).some((g) => g.id === KinoPubApi.ANIME_GENRE_ID);
  }

  /**
   * Port of the add-on's _get_anime_excluded: fills a full page of items with
   * anime dropped, carrying the overshoot via pagination.start_from.
   */
  async getItemsExcludeAnime(endpoint, params) {
    const data = { ...params };
    let startFrom = parseInt(data.start_from, 10) || 0;
    delete data.start_from;
    const items = [];
    let pagination = {};
    for (;;) {
      const response = await this.request(endpoint, data);
      const apiItems = response.items || [];
      pagination = response.pagination || {};
      const pageSize = parseInt(pagination.perpage, 10) || 25;
      const nonAnime = apiItems.slice(startFrom).filter((i) => !KinoPubApi.isAnime(i));
      if (items.length + nonAnime.length >= pageSize) {
        const needed = pageSize - items.length;
        items.push(...nonAnime.slice(0, needed));
        const lastId = nonAnime[needed - 1].id;
        const lastIndex = apiItems.findIndex((i) => i.id === lastId);
        pagination.current = parseInt(pagination.current, 10) - 1;
        pagination.start_from = lastIndex + 1;
        break;
      }
      items.push(...nonAnime);
      if (parseInt(pagination.current, 10) >= parseInt(pagination.total, 10)) break;
      data.page = parseInt(pagination.current, 10) + 1;
      startFrom = 0;
    }
    return { items, pagination };
  }
}

module.exports = { KinoPubApi, ApiError };

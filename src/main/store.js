"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  // auth
  access_token: "",
  refresh_token: "",
  access_token_expire: 0,
  // playback
  video_quality: "1080p", // 2160p | 1080p | 720p | 480p
  stream_type: "hls4", // hls | hls2 | hls4
  loc: "ru", // CDN location: ru | nl
  ask_quality: false,
  // listing
  sort_by: "rating", // updated|created|year|title|rating|kinopoisk_rating|imdb_rating|views|watchers
  sort_direction: "desc", // asc | desc
  exclude_anime: false,
  mark_advert: false,
  // search
  history_max_qty: 10,
  search_history: [],
  // main menu visibility
  show_search: true,
  show_sort: true,
  show_tv: true,
  show_collections: true,
  show_movies: true,
  show_serials: true,
  show_tvshows: true,
  show_3d: true,
  show_concerts: true,
  show_documovies: true,
  show_docuserials: true,
  // window
  window_bounds: null,
  volume: 1,
  muted: false,
};

class Store {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, "settings.json");
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = { ...DEFAULTS, ...raw };
    } catch (e) {
      /* first run or corrupt file — use defaults */
    }
  }

  get(key) {
    return key === undefined ? { ...this.data } : this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this._save();
    return { ...this.data };
  }

  addSearchHistory(title) {
    const list = this.data.search_history.filter((t) => t !== title);
    list.unshift(title);
    this.data.search_history = list.slice(0, Number(this.data.history_max_qty) || 10);
    this._save();
    return this.data.search_history;
  }

  clearSearchHistory() {
    this.data.search_history = [];
    this._save();
  }

  resetAuth() {
    this.data.access_token = "";
    this.data.refresh_token = "";
    this.data.access_token_expire = 0;
    this._save();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }
}

module.exports = { Store, DEFAULTS };

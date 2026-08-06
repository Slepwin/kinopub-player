"use strict";

/**
 * Renderer-side API helpers on top of window.kp (IPC bridge).
 * Mirrors the endpoints used by kodi.kino.pub.
 */

const API = {
  settings: null, // cached settings object, kept in sync via saveSettings()

  async init() {
    this.settings = await kp.settings.get();
  },

  async saveSettings(patch) {
    this.settings = await kp.settings.set(patch);
    return this.settings;
  },

  /* ---------------------------------------------------------- listings --- */

  sortingParams() {
    const dir = this.settings.sort_direction === "desc" ? "-" : "";
    return { sort: `${dir}${this.settings.sort_by}` };
  },

  /**
   * Generic item listing. heading: fresh|hot|popular|null (null => /items with sort)
   * extra: {type, genre, letter, title, page, start_from, sort}
   */
  async getItems(heading, extra = {}) {
    const endpoint = heading ? `items/${heading}` : "items";
    const params = { ...extra };
    if (this.settings.exclude_anime) {
      return kp.getItemsNoAnime(endpoint, params);
    }
    const resp = await kp.get(endpoint, params);
    return { items: resp.items || [], pagination: resp.pagination || null };
  },

  getItem(id) {
    return kp.get(`items/${id}`).then((r) => r.item);
  },

  getGenres(type) {
    return kp.get("genres", { type }).then((r) => r.items || []);
  },

  getSimilar(id) {
    return kp.get("items/similar", { id }).then((r) => r.items || []);
  },

  getComments(id) {
    return kp.get("items/comments", { id });
  },

  getTrailer(id) {
    return kp.get("items/trailer", { id }).then((r) => r.trailer);
  },

  /* ---------------------------------------------------------- watching --- */

  getWatchingInfo(id) {
    return kp.get("watching", { id }).then((r) => r.item);
  },

  getWatchingSerials() {
    return kp.get("watching/serials", { subscribed: 1 }).then((r) => r.items || []);
  },

  getWatchingMovies() {
    return kp.get("watching/movies").then((r) => r.items || []);
  },

  toggleWatched({ id, season, video }) {
    return kp.get("watching/toggle", { id, season, video });
  },

  toggleWatchlist(id) {
    return kp.get("watching/togglewatchlist", { id });
  },

  marktime({ id, season, video, time }) {
    return kp.get("watching/marktime", { id, season, video, time });
  },

  /* --------------------------------------------------------- bookmarks --- */

  getBookmarkFolders() {
    return kp.get("bookmarks").then((r) => r.items || []);
  },

  getBookmarkFolder(folderId, params = {}) {
    return kp.get(`bookmarks/${folderId}`, params);
  },

  createBookmarkFolder(title) {
    return kp.post("bookmarks/create", { title });
  },

  removeBookmarkFolder(folder) {
    return kp.post("bookmarks/remove-folder", { folder });
  },

  addBookmark(item, folder) {
    return kp.post("bookmarks/add", { item, folder });
  },

  removeBookmark(item, folder) {
    return kp.post("bookmarks/remove-item", { item, folder });
  },

  getItemFolders(item) {
    return kp.get("bookmarks/get-item-folders", { item }).then((r) => r.folders || []);
  },

  /* ------------------------------------------------------- collections --- */

  getCollections(sort, page) {
    return kp.get("collections/index", { sort, page });
  },

  getCollection(id) {
    return kp.get("collections/view", { id }).then((r) => r.items || []);
  },

  /* ---------------------------------------------------------------- tv --- */

  getTvChannels() {
    return kp.get("tv/index").then((r) => r.channels || []);
  },

  /* -------------------------------------------------------------- user --- */

  getUser() {
    return kp.get("user").then((r) => r.user);
  },

  /* -------------------------------------------------------- media urls --- */

  /**
   * Collects available files for a video: [{quality, urls: {hls,hls2,hls4,...}}]
   * and returns the playback URL for current settings, or `null` to ask.
   */
  chooseMediaUrl(video, useLoc = true) {
    const files = video.files || [];
    const byQuality = {};
    for (const f of files) byQuality[f.quality] = f.url;
    const streamType = this.settings.stream_type;
    const wanted = this.settings.video_quality;
    let quality = wanted;
    if (!byQuality[quality] || !byQuality[quality][streamType]) {
      // highest available fallback
      const qualities = Object.keys(byQuality).sort((a, b) => qualityRank(a) - qualityRank(b));
      quality = qualities[qualities.length - 1];
    }
    if (!quality) return null;
    const url = byQuality[quality][streamType] || Object.values(byQuality[quality])[0];
    return { url: useLoc ? this.withLoc(url) : url, quality };
  },

  qualityOptions(video, useLoc = true) {
    const streamType = this.settings.stream_type;
    return (video.files || [])
      .map((f) => ({ quality: f.quality, url: f.url[streamType] || Object.values(f.url)[0] }))
      .filter((o) => o.url)
      .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))
      .map((o) => ({ quality: o.quality, url: useLoc ? this.withLoc(o.url) : o.url }));
  },

  /** Rewrites the URL query to loc=<setting> like the add-on's _choose_cdn_loc. */
  withLoc(url) {
    try {
      const u = new URL(url);
      u.search = `?loc=${this.settings.loc}`;
      return u.toString();
    } catch (e) {
      return url;
    }
  },
};

const CONTENT_TYPES = [
  { key: "movies", type: "movie", title: "Фильмы", show: "show_movies" },
  { key: "serials", type: "serial", title: "Сериалы", show: "show_serials" },
  { key: "tvshows", type: "tvshow", title: "ТВ-шоу", show: "show_tvshows" },
  { key: "3d", type: "3d", title: "3D", show: "show_3d" },
  { key: "concerts", type: "concert", title: "Концерты", show: "show_concerts" },
  { key: "documovies", type: "documovie", title: "Документальные фильмы", show: "show_documovies" },
  { key: "docuserials", type: "docuserial", title: "Документальные сериалы", show: "show_docuserials" },
];

const SORT_OPTIONS = [
  { value: "updated", label: "По дате обновления" },
  { value: "created", label: "По дате добавления" },
  { value: "year", label: "По году" },
  { value: "title", label: "По названию" },
  { value: "rating", label: "По рейтингу" },
  { value: "kinopoisk_rating", label: "По рейтингу Кинопоиска" },
  { value: "imdb_rating", label: "По рейтингу IMDB" },
  { value: "views", label: "По просмотрам" },
  { value: "watchers", label: "По количеству зрителей" },
];

// item.type -> is it a "series-like" item (has seasons)
function isSerialType(item) {
  return ["serial", "docuserial", "tvshow"].includes(item.type) && item.subtype !== "multi";
}

function isMultiType(item) {
  return item.subtype === "multi";
}

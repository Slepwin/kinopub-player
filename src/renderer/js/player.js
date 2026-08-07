"use strict";

/**
 * Playback engine + MPC-style transport controls.
 *
 * Progress reporting mirrors kodi.kino.pub's Player:
 *  - while playing, remember the current position (marktime);
 *  - on stop: >90% watched -> watching/toggle (mark watched),
 *             >180s        -> watching/marktime (resume point),
 *             <180s with existing resume -> reset resume point to 0;
 *  - on natural end: mark watched if not yet.
 * Additionally the position is synced every 30s so a crash doesn't lose it.
 */

const IGNORE_SECONDS_AT_START = 180;
const PLAYCOUNT_MIN_PERCENT = 90;
const MARKTIME_SYNC_INTERVAL = 30000;

const Player = {
  video: null,
  hls: null,
  queue: [], // [{itemId, title, sub, video, season, number, watching, poster, kind}]
  queueIndex: -1,
  current: null, // queue entry being played
  currentQuality: null,
  marktime: 0,
  _syncTimer: null,
  _osdTimer: null,
  _wasResumeSet: false,
  _reportedWatched: false,
  active: false, // player view visible

  init() {
    this.video = $("#video");
    const v = this.video;

    v.volume = Number(API.settings.volume ?? 1);
    v.muted = Boolean(API.settings.muted);
    $("#volume").value = Math.round(v.volume * 100);

    v.addEventListener("timeupdate", () => this._onTimeUpdate());
    v.addEventListener("progress", () => this._updateBuffered());
    v.addEventListener("play", () => this._updateStatus());
    v.addEventListener("pause", () => this._updateStatus());
    v.addEventListener("ended", () => this._onEnded());
    v.addEventListener("error", () => {
      if (this.current) toast("Ошибка воспроизведения", { error: true });
    });
    v.addEventListener("click", () => this.togglePause());
    v.addEventListener("dblclick", () => this.toggleFullscreen());

    // transport buttons
    $("#c-play").onclick = () => this.play();
    $("#c-pause").onclick = () => this.pause();
    $("#c-stop").onclick = () => this.stop();
    $("#c-prev").onclick = () => this.playRelative(-1);
    $("#c-next").onclick = () => this.playRelative(1);
    $("#c-rew").onclick = () => this.seekBy(-10);
    $("#c-fwd").onclick = () => this.seekBy(10);
    $("#c-full").onclick = () => this.toggleFullscreen();
    $("#c-mute").onclick = () => this.toggleMute();
    // stopPropagation: the opening click must not reach the document-level
    // handler that hides #ctx-menu, or the menu closes as soon as it opens
    $("#c-quality").onclick = (e) => { e.stopPropagation(); this.qualityMenu(); };
    $("#c-subs").onclick = (e) => { e.stopPropagation(); this.subtitlesMenu(); };
    $("#c-audio").onclick = (e) => { e.stopPropagation(); this.audioMenu(); };

    $("#volume").addEventListener("input", (e) => {
      v.volume = Number(e.target.value) / 100;
      v.muted = false;
      API.saveSettings({ volume: v.volume, muted: false });
      this.osd(`Громкость: ${e.target.value}%`);
    });

    this._initSeekbar();
    this._updateStatus();
    setInterval(() => this._periodicSync(), MARKTIME_SYNC_INTERVAL);
  },

  /* -------------------------------------------------------------- queue --- */

  /**
   * @param {Array} queue playable entries
   * @param {number} index start position
   */
  async openQueue(queue, index) {
    await this._finishCurrent(); // report progress of whatever was playing
    this.queue = queue;
    this.queueIndex = index;
    await this._startCurrent();
  },

  async playRelative(delta) {
    const ni = this.queueIndex + delta;
    if (ni < 0 || ni >= this.queue.length) {
      this.osd(delta > 0 ? "Это последний эпизод" : "Это первый эпизод");
      return;
    }
    await this._finishCurrent();
    this.queueIndex = ni;
    await this._startCurrent();
  },

  async _startCurrent() {
    const entry = this.queue[this.queueIndex];
    if (!entry) return;
    // Not current until a stream URL is actually chosen: aborting any of the
    // dialogs below must not leave progress reporting attached to this entry
    // while the old (already finished) media is still in the <video>.
    this.current = null;
    this._updateStatus();

    // pick quality / stream (TV streams and trailers keep their URLs untouched)
    const useLoc = !["tv", "trailer"].includes(entry.kind);
    let media = null;
    if (API.settings.ask_quality && useLoc) {
      const opts = API.qualityOptions(entry.video, useLoc);
      if (!opts.length) {
        toast("Нет доступных потоков", { error: true });
        return;
      }
      const chosen = await Dialogs.select(
        "Выберите качество видео",
        opts.map((o) => ({ label: o.quality, value: o }))
      );
      if (!chosen) return;
      media = { url: chosen.url, quality: chosen.quality };
    } else {
      media = API.chooseMediaUrl(entry.video, useLoc);
    }
    if (!media) {
      toast("Нет доступных потоков", { error: true });
      return;
    }

    // resume?
    const resume = Number(entry.watching?.time) || 0;
    const duration = Number(entry.watching?.duration) || Number(entry.video.duration) || 0;
    let startAt = 0;
    if (resume > IGNORE_SECONDS_AT_START && resume !== duration) {
      const cont = await Dialogs.show({
        title: "Продолжить просмотр",
        bodyNodes: el("div", { text: `Продолжить с ${fmtTime(resume)}?` }),
        buttons: [
          { label: "Продолжить", primary: true, value: "resume" },
          { label: "Сначала", value: "restart" },
        ],
      });
      if (cont === undefined) return;
      if (cont === "resume") startAt = resume;
    }

    this.current = entry;
    this._reportedWatched = Number(entry.watching?.status) === 1;
    this.marktime = 0;
    this._wasResumeSet = resume > IGNORE_SECONDS_AT_START;
    this.currentQuality = media.quality;

    this._loadMedia(media.url, startAt);
    this._setupSubtitles(entry.video.subtitles || []);
    App.showPlayer();
    $("#player-overlay-title").textContent = this._currentTitle();
    this._flashTitle();
    $("#c-quality").textContent = (media.quality || "").replace("p", "ᴾ").length > 5
      ? "HD" : (media.quality || "HD");
    this._updateStatus();
    this._updateNavButtons();
  },

  _loadMedia(url, startAt) {
    this._destroyHls();
    const v = this.video;
    const isHls = /\.m3u8($|\?)/.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      this.hls = new Hls({
        startPosition: startAt > 0 ? startAt : -1,
        maxBufferLength: 60,
      });
      this.hls.on(Hls.Events.ERROR, (e, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              this.hls.recoverMediaError();
              break;
            default:
              toast(`Ошибка потока: ${data.details}`, { error: true });
              this._destroyHls();
          }
        }
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(v);
      v.play().catch(() => {});
    } else {
      v.src = url;
      if (startAt > 0) {
        v.addEventListener("loadedmetadata", () => { v.currentTime = startAt; }, { once: true });
      }
      v.play().catch(() => {});
    }
  },

  _destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute("src");
  },

  /* ---------------------------------------------------------- subtitles --- */

  async _setupSubtitles(subtitles) {
    // remove previous external tracks
    $$("track", this.video).forEach((t) => t.remove());
    this._extSubs = [];
    for (const [i, sub] of (subtitles || []).entries()) {
      if (!sub.url) continue;
      try {
        const srt = await kp.fetchSubtitles(sub.url);
        const vtt = srtToVtt(srt);
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        const track = el("track", {
          kind: "subtitles",
          label: sub.lang || `Субтитры ${i + 1}`,
          srclang: sub.lang || "ru",
          src: blobUrl,
        });
        this.video.append(track);
        this._extSubs.push(track);
      } catch (e) {
        console.warn("subtitle load failed", e);
      }
    }
  },

  subtitlesMenu() {
    const items = [];
    const tt = this.video.textTracks;
    const anyShown = [...tt].some((t) => t.mode === "showing");
    items.push({
      label: "Выключены",
      checked: !anyShown,
      action: () => {
        [...tt].forEach((t) => (t.mode = "disabled"));
        if (this.hls) this.hls.subtitleTrack = -1;
      },
    });
    [...tt].forEach((t, i) => {
      items.push({
        label: t.label || t.language || `Дорожка ${i + 1}`,
        checked: t.mode === "showing",
        action: () => {
          [...tt].forEach((x) => (x.mode = "disabled"));
          t.mode = "showing";
        },
      });
    });
    // hls.js embedded subtitle tracks
    if (this.hls && this.hls.subtitleTracks.length) {
      this.hls.subtitleTracks.forEach((t) => {
        items.push({
          label: `${t.name || t.lang || "HLS"} (встроенные)`,
          checked: this.hls.subtitleTrack === t.id,
          action: () => { this.hls.subtitleTrack = t.id; },
        });
      });
    }
    if (items.length === 1) items.push({ label: "Нет субтитров", disabled: true });
    this._buttonMenu("#c-subs", items);
  },

  audioMenu() {
    const items = [];
    if (this.hls && this.hls.audioTracks.length > 1) {
      this.hls.audioTracks.forEach((t) => {
        items.push({
          label: t.name || t.lang || `Дорожка ${t.id + 1}`,
          checked: this.hls.audioTrack === t.id,
          action: () => { this.hls.audioTrack = t.id; },
        });
      });
    } else {
      items.push({ label: "Одна аудиодорожка", disabled: true });
    }
    this._buttonMenu("#c-audio", items);
  },

  qualityMenu() {
    if (!this.current) return;
    const useLoc = !["tv", "trailer"].includes(this.current.kind);
    const opts = API.qualityOptions(this.current.video, useLoc);
    const items = opts.map((o) => ({
      label: o.quality,
      checked: o.quality === this.currentQuality,
      action: async () => {
        const pos = this.video.currentTime;
        this.currentQuality = o.quality;
        $("#c-quality").textContent = o.quality;
        this._loadMedia(o.url, pos);
      },
    }));
    this._buttonMenu("#c-quality", items);
  },

  _buttonMenu(btnSel, items) {
    const r = $(btnSel).getBoundingClientRect();
    CtxMenu.show(r.left, r.top - 8 - items.length * 26, items);
  },

  /* ----------------------------------------------------------- controls --- */

  play() {
    if (!this.current) return;
    this.video.play().catch(() => {});
    this._flashTitle(); // show the title, like on start
  },

  pause() {
    this.video.pause();
    if (this.current) this._flashTitle(); // show the title, like on start
    this._sendMarktime(); // keep the server position fresh on pause
  },

  togglePause() {
    if (!this.current) return;
    this.video.paused ? this.play() : this.pause();
    this.osd(this.video.paused ? "Пауза" : "Воспроизведение");
  },

  async stop() {
    await this._finishCurrent();
    this._destroyHls();
    this.current = null;
    this.currentQuality = null;
    this.queue = [];
    this.queueIndex = -1;
    App.showLibrary();
    this._updateStatus();
    this._updateSeekbar(0, 0);
    $("#time-display").textContent = "00:00:00 / 00:00:00";
  },

  seekBy(sec) {
    if (!this.current) return;
    this.video.currentTime = Math.max(0, this.video.currentTime + sec);
    this.osd(`${sec > 0 ? "+" : ""}${sec} сек`);
  },

  toggleMute() {
    const v = this.video;
    v.muted = !v.muted;
    API.saveSettings({ muted: v.muted });
    this.osd(v.muted ? "Звук выключен" : "Звук включён");
  },

  async toggleFullscreen() {
    const fs = await kp.toggleFullscreen();
    document.body.classList.toggle("fullscreen", fs);
    document.body.classList.remove("show-chrome");
  },

  osd(text) {
    const osd = $("#osd");
    osd.textContent = text;
    osd.classList.remove("hidden");
    clearTimeout(this._osdTimer);
    this._osdTimer = setTimeout(() => osd.classList.add("hidden"), 1600);
  },

  _currentTitle() {
    const c = this.current;
    if (!c) return "";
    return c.sub ? `${c.title} — ${c.sub}` : c.title;
  },

  _flashTitle() {
    const t = $("#player-overlay-title");
    t.classList.remove("hidden");
    clearTimeout(this._titleTimer);
    this._titleTimer = setTimeout(() => t.classList.add("hidden"), 4000);
  },

  _updateNavButtons() {
    $("#c-prev").disabled = this.queueIndex <= 0;
    $("#c-next").disabled = this.queueIndex >= this.queue.length - 1;
  },

  /* ------------------------------------------------------------ seekbar --- */

  _initSeekbar() {
    const bar = $("#seekbar");
    let dragging = false;
    const posToTime = (e) => {
      const r = bar.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      return frac * (this.video.duration || 0);
    };
    bar.addEventListener("mousedown", (e) => {
      if (!this.current || !this.video.duration) return;
      dragging = true;
      bar.classList.add("seeking");
      this.video.currentTime = posToTime(e);
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) this.video.currentTime = posToTime(e);
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      bar.classList.remove("seeking");
    });
  },

  _updateSeekbar(cur, dur) {
    const frac = dur > 0 ? cur / dur : 0;
    $("#seek-progress").style.width = `${frac * 100}%`;
    $("#seek-thumb").style.left = `${frac * 100}%`;
  },

  _updateBuffered() {
    const v = this.video;
    if (!v.duration || !v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    $("#seek-buffered").style.width = `${(end / v.duration) * 100}%`;
  },

  _onTimeUpdate() {
    const v = this.video;
    if (!v.duration) return;
    if (!v.paused) this.marktime = Math.floor(v.currentTime);
    this._updateSeekbar(v.currentTime, v.duration);
    $("#time-display").textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
    // mark watched as soon as the threshold is crossed (like Kodi's playcount)
    if (
      this.current && !this._reportedWatched &&
      (100 * v.currentTime) / v.duration > PLAYCOUNT_MIN_PERCENT
    ) {
      this._reportedWatched = true;
      this._toggleWatchedOnServer().catch(() => {});
    }
  },

  _updateStatus() {
    const st = $("#status-text");
    const sm = $("#status-media");
    if (!this.current) {
      st.textContent = "Готово";
      sm.textContent = "";
      return;
    }
    st.textContent = `${this.video.paused ? "Пауза" : "Воспроизведение"} — ${this._currentTitle()}`;
    const kind = this.current.kind === "tv" ? "ТВ" :
      API.settings.stream_type.toUpperCase();
    sm.textContent = `${this.currentQuality || ""} ${kind}`.trim();
  },

  async _onEnded() {
    if (!this.current) return;
    if (!this._reportedWatched) {
      this._reportedWatched = true;
      await this._toggleWatchedOnServer().catch(() => {});
    }
    // autoplay next episode
    if (this.queueIndex < this.queue.length - 1) {
      this.queueIndex += 1;
      await this._startCurrent();
    } else {
      this.stop();
    }
  },

  /* --------------------------------------------------- progress reports --- */

  _baseData() {
    const c = this.current;
    const data = { id: c.itemId };
    if (c.kind === "tv" || c.kind === "trailer") return null; // not tracked
    if (c.season) data.season = c.season;
    if (c.number) data.video = c.number;
    return data;
  },

  async _toggleWatchedOnServer() {
    const data = this._baseData();
    if (!data) return;
    await API.toggleWatched(data);
  },

  async _sendMarktime() {
    const data = this._baseData();
    if (!data || this.marktime <= 0) return;
    try {
      await API.marktime({ ...data, time: this.marktime });
    } catch (e) {
      /* non-critical */
    }
  },

  _periodicSync() {
    if (this.current && !this.video.paused && this.marktime > IGNORE_SECONDS_AT_START &&
        !this._reportedWatched) {
      this._sendMarktime();
    }
  },

  /** Add-on's onPlayBackStopped logic. */
  async _finishCurrent() {
    if (!this.current) return;
    const data = this._baseData();
    this.video.pause();
    if (!data) return;
    const duration = this.video.duration || Number(this.current.watching?.duration) || 0;
    const shouldMarkWatched =
      duration > 0 && (100 * this.marktime) / duration > PLAYCOUNT_MIN_PERCENT;
    try {
      if (shouldMarkWatched) {
        if (!this._reportedWatched) {
          await API.toggleWatched(data);
          this._reportedWatched = true;
        }
      } else if (this.marktime > IGNORE_SECONDS_AT_START) {
        await API.marktime({ ...data, time: this.marktime });
      } else if (this._wasResumeSet) {
        await API.marktime({ ...data, time: 0 });
      }
    } catch (e) {
      console.warn("progress report failed", e);
    }
  },
};

/* ----------------------------------------------------------- srt -> vtt --- */

function srtToVtt(srt) {
  const body = srt
    .replace(/\r+/g, "")
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n");
      if (/^\d+$/.test(lines[0])) lines.shift(); // cue number
      if (!lines.length) return "";
      lines[0] = (lines[0] || "").replace(
        /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
        "$1.$2"
      );
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

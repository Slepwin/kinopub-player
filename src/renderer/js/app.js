"use strict";

const App = {
  playerVisible: false,

  async init() {
    await API.init();
    Player.init();
    this.buildSidebar();
    this.bindMenubar();
    this.bindKeyboard();
    this.bindChrome();
    this.wireAuth();

    const { authorized } = await kp.auth.state();
    Nav.home();
    if (!authorized) this.showAuthDialog();
  },

  /* ------------------------------------------------------------ layout --- */

  showPlayer() {
    this.playerVisible = true;
    $("#player").classList.remove("hidden");
    $("#library").classList.add("hidden");
  },

  showLibrary() {
    this.playerVisible = false;
    $("#library").classList.remove("hidden");
    $("#player").classList.add("hidden");
    if (document.body.classList.contains("fullscreen")) Player.toggleFullscreen();
  },

  setBreadcrumb(route) {
    const names = {
      home: "Главное меню",
      section: route.params?.ct?.title,
      search: "Поиск",
      search_results: `Поиск: ${route.params?.title || ""}`,
      detail: "Карточка",
      similar: `Похожие: ${route.params?.title || ""}`,
      bookmarks: "Закладки",
      bookmark_folder: `Закладки / ${route.params?.folder?.title || ""}`,
      watching_serials: "Я смотрю",
      watching_movies: "Недосмотренные фильмы",
      collections: "Подборки",
      collection: `Подборка: ${route.params?.title || ""}`,
      tv: "ТВ",
      sorted_all: "Все по порядку",
      profile: "Профиль",
    };
    const bc = $("#breadcrumb");
    bc.innerHTML = "";
    bc.append(
      el("span", { class: "crumb", text: "kino.pub", onclick: () => Nav.home() }),
      el("span", { class: "crumb-sep", text: "»" }),
      el("span", { text: names[route.name] || route.name })
    );
  },

  highlightSidebar(route) {
    $$(".side-item").forEach((n) => {
      const r = n._route;
      const active = r && (r.name === route.name &&
        (r.name !== "section" || r.params?.ct?.key === route.params?.ct?.key));
      n.classList.toggle("active", Boolean(active));
    });
  },

  buildSidebar() {
    const s = API.settings;
    const side = $("#sidebar");
    side.innerHTML = "";
    const add = (title, ico, route) => {
      const item = el("div", { class: "side-item", onclick: () => Nav.push(route) }, [
        el("span", { class: "ico", text: ico }),
        el("span", { text: title }),
      ]);
      item._route = route;
      side.append(item);
    };
    add("Главное меню", "⌂", { name: "home" });
    if (s.show_search) add("Поиск", "🔍", { name: "search", params: { type: "all" } });
    side.append(el("div", { class: "side-header", text: "Моё" }));
    add("Закладки", "📁", { name: "bookmarks" });
    add("Я смотрю", "▶", { name: "watching_serials" });
    add("Недосмотренные", "⏸", { name: "watching_movies" });
    side.append(el("div", { class: "side-header", text: "Разделы" }));
    if (s.show_sort) add("Все по порядку", "↕", { name: "sorted_all", params: {} });
    if (s.show_tv) add("ТВ", "📺", { name: "tv" });
    if (s.show_collections) add("Подборки", "🗂", { name: "collections", params: {} });
    for (const ct of CONTENT_TYPES) {
      if (s[ct.show]) add(ct.title, "•", { name: "section", params: { ct } });
    }
    side.append(el("div", { class: "side-header", text: "" }));
    side.append(
      el("div", { class: "side-item", onclick: () => this.showSettings() }, [
        el("span", { class: "ico", text: "⚙" }),
        el("span", { text: "Настройки" }),
      ]),
      el("div", { class: "side-item", onclick: () => this.showProfile() }, [
        el("span", { class: "ico", text: "👤" }),
        el("span", { text: "Профиль" }),
      ])
    );
  },

  /* ----------------------------------------------------------- menubar --- */

  bindMenubar() {
    const menus = {
      file: () => [
        { label: "Профиль kino.pub", action: () => this.showProfile() },
        { label: "Настройки…", hotkey: "O", action: () => this.showSettings() },
        "-",
        { label: "Сброс авторизации", action: () => this.resetAuth() },
        "-",
        { label: "Выход", hotkey: "Alt+F4", action: () => window.close() },
      ],
      view: () => [
        {
          label: "Библиотека",
          checked: !this.playerVisible,
          action: () => this.showLibrary(),
        },
        {
          label: "Плеер",
          checked: this.playerVisible,
          disabled: !Player.current,
          action: () => this.showPlayer(),
        },
        "-",
        { label: "Во весь экран", hotkey: "F", action: () => Player.toggleFullscreen() },
      ],
      play: () => [
        {
          label: Player.video && !Player.video.paused ? "Пауза" : "Воспроизведение",
          hotkey: "Space",
          disabled: !Player.current,
          action: () => Player.togglePause(),
        },
        { label: "Стоп", disabled: !Player.current, action: () => Player.stop() },
        "-",
        { label: "Назад 10 сек", hotkey: "←", disabled: !Player.current, action: () => Player.seekBy(-10) },
        { label: "Вперёд 10 сек", hotkey: "→", disabled: !Player.current, action: () => Player.seekBy(10) },
        { label: "Предыдущий эпизод", disabled: !Player.current, action: () => Player.playRelative(-1) },
        { label: "Следующий эпизод", disabled: !Player.current, action: () => Player.playRelative(1) },
        "-",
        { label: "Качество…", disabled: !Player.current, action: () => Player.qualityMenu() },
        { label: "Аудиодорожка…", disabled: !Player.current, action: () => Player.audioMenu() },
        { label: "Субтитры…", disabled: !Player.current, action: () => Player.subtitlesMenu() },
      ],
      navigate: () => [
        { label: "Назад", hotkey: "Backspace", action: () => Nav.back() },
        { label: "Главное меню", action: () => Nav.home() },
        "-",
        { label: "Поиск", action: () => Nav.push({ name: "search", params: { type: "all" } }) },
        { label: "Я смотрю", action: () => Nav.push({ name: "watching_serials" }) },
        { label: "Недосмотренные", action: () => Nav.push({ name: "watching_movies" }) },
        { label: "ТВ", action: () => Nav.push({ name: "tv" }) },
        { label: "Подборки", action: () => Nav.push({ name: "collections", params: {} }) },
        "-",
        ...CONTENT_TYPES.filter((ct) => API.settings[ct.show]).map((ct) => ({
          label: ct.title,
          action: () => Nav.push({ name: "section", params: { ct } }),
        })),
      ],
      favorites: () => [
        { label: "Закладки", action: () => Nav.push({ name: "bookmarks" }) },
        {
          label: "Добавить текущий в закладки…",
          disabled: !Player.current || ["tv", "trailer"].includes(Player.current?.kind),
          action: () => Playback.editBookmarks(Player.current.itemId),
        },
      ],
      help: () => [
        { label: "kino.pub", action: () => kp.openExternal("https://kino.pub") },
        { label: "Аддон kodi.kino.pub (GitHub)", action: () => kp.openExternal("https://github.com/quarckster/kodi.kino.pub") },
        "-",
        { label: "О программе", action: () => Dialogs.alert("О программе",
          "<b>KinoPub Player</b><br>Плеер kino.pub на Electron в стиле Media Player Classic.<br>" +
          "Основан на функциональности аддона kodi.kino.pub.") },
      ],
    };

    $$(".menu-root").forEach((rootEl) => {
      rootEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = rootEl.getBoundingClientRect();
        CtxMenu.show(r.left, r.bottom + 1, menus[rootEl.dataset.menu]());
      });
    });
  },

  /* ---------------------------------------------------------- keyboard --- */

  bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (Dialogs._stack.length) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          Player.togglePause();
          break;
        case "f": case "F": case "а": case "А":
          Player.toggleFullscreen();
          break;
        case "m": case "M": case "ь": case "Ь":
          Player.toggleMute();
          break;
        case "ArrowLeft":
          if (Player.current) Player.seekBy(e.shiftKey ? -60 : -10);
          break;
        case "ArrowRight":
          if (Player.current) Player.seekBy(e.shiftKey ? 60 : 10);
          break;
        case "ArrowUp":
          if (this.playerVisible) {
            e.preventDefault();
            Player.video.volume = Math.min(1, Player.video.volume + 0.05);
            $("#volume").value = Math.round(Player.video.volume * 100);
            Player.osd(`Громкость: ${Math.round(Player.video.volume * 100)}%`);
          }
          break;
        case "ArrowDown":
          if (this.playerVisible) {
            e.preventDefault();
            Player.video.volume = Math.max(0, Player.video.volume - 0.05);
            $("#volume").value = Math.round(Player.video.volume * 100);
            Player.osd(`Громкость: ${Math.round(Player.video.volume * 100)}%`);
          }
          break;
        case "Backspace":
          if (this.playerVisible) this.showLibrary();
          else Nav.back();
          break;
        case "Escape":
          if (document.body.classList.contains("fullscreen")) Player.toggleFullscreen();
          else if (this.playerVisible) this.showLibrary();
          break;
      }
    });
  },

  bindChrome() {
    $("#btn-back").onclick = () => Nav.back();
    $("#btn-home").onclick = () => Nav.home();
    const qs = $("#quick-search");
    qs.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && qs.value.trim()) {
        await kp.history.add(qs.value.trim());
        API.settings.search_history = (await kp.settings.get()).search_history;
        Nav.push({ name: "search_results", params: { type: "all", title: qs.value.trim() } });
        qs.value = "";
        qs.blur();
      }
    });
    // fullscreen: reveal chrome when the cursor is near the bottom edge
    document.addEventListener("mousemove", (e) => {
      if (!document.body.classList.contains("fullscreen")) return;
      const nearBottom = e.clientY > window.innerHeight - 90;
      const nearTop = e.clientY < 30;
      document.body.classList.toggle("show-chrome", nearBottom || nearTop);
    });
  },

  /* -------------------------------------------------------------- auth --- */

  wireAuth() {
    kp.on("auth:code", ({ user_code, verification_uri }) => {
      Dialogs.closeAll();
      const dlg = Dialogs.show({
        title: "Активация устройства",
        bodyNodes: [
          el("div", { text: "Откройте страницу и введите код:" }),
          el("div", { class: "auth-url" }, [
            el("a", { text: verification_uri, onclick: () => kp.openExternal(verification_uri) }),
          ]),
          el("div", { class: "auth-code", text: user_code }),
          el("div", { style: "text-align:center;color:#555", text: "Ожидание подтверждения…" }),
        ],
        buttons: [{ label: "Отмена", value: "cancel" }],
      });
      dlg.then((v) => {
        if (v === "cancel") kp.auth.cancel();
      });
    });
    kp.on("auth:success", () => {
      Dialogs.closeAll();
      toast("Устройство активировано");
      Nav.home();
    });
    kp.on("auth:error", ({ message }) => {
      Dialogs.closeAll();
      Dialogs.show({
        title: "Ошибка авторизации",
        bodyNodes: el("div", { text: message }),
        buttons: [
          { label: "Повторить", primary: true, value: "retry" },
          { label: "Отмена", value: null },
        ],
      }).then((v) => {
        if (v === "retry") kp.auth.start();
      });
    });
    kp.on("auth:required", () => this.showAuthDialog());
  },

  showAuthDialog() {
    Dialogs.closeAll();
    Dialogs.show({
      title: "kino.pub",
      bodyNodes: el("div", { text: "Требуется активация устройства на kino.pub." }),
      buttons: [{ label: "Активировать", primary: true, value: "go" }],
    }).then((v) => {
      if (v === "go") kp.auth.start();
    });
  },

  async resetAuth() {
    if (await Dialogs.confirm("kino.pub", "Сбросить авторизацию устройства?")) {
      await kp.auth.reset();
    }
  },

  async showProfile() {
    try {
      const user = await API.getUser();
      Dialogs.alert(
        "Данные учётной записи",
        `<b>Имя пользователя:</b> ${escapeHtml(user.username)}<br>` +
        `<b>Дата регистрации:</b> ${fmtDate(user.reg_date)}<br>` +
        `<b>Осталось дней подписки:</b> ${Math.floor(user.subscription?.days ?? 0)}`
      );
    } catch (e) {
      toast(`Не удалось получить профиль: ${e.message}`, { error: true });
    }
  },

  /* ---------------------------------------------------------- settings --- */

  async showSettings() {
    const s = API.settings;
    const mkSelect = (options, value) => {
      const sel = el("select", {}, options.map((o) =>
        el("option", { value: o.value ?? o, text: o.label ?? o })));
      sel.value = value;
      return sel;
    };
    const mkCheck = (checked) => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = Boolean(checked);
      return cb;
    };

    const quality = mkSelect(["2160p", "1080p", "720p", "480p"], s.video_quality);
    const stream = mkSelect(["hls", "hls2", "hls4"], s.stream_type);
    const loc = mkSelect(
      [{ value: "ru", label: "Россия" }, { value: "nl", label: "Нидерланды" }], s.loc);
    const askQ = mkCheck(s.ask_quality);
    const sortBy = mkSelect(SORT_OPTIONS, s.sort_by);
    const sortDir = mkSelect(
      [{ value: "desc", label: "По убыванию" }, { value: "asc", label: "По возрастанию" }],
      s.sort_direction);
    const useProxy = mkCheck(s.use_system_proxy);
    const exclAnime = mkCheck(s.exclude_anime);
    const markAdvert = mkCheck(s.mark_advert);
    const histQty = mkSelect(["10", "15", "20"], String(s.history_max_qty));

    const menuChecks = {};
    const menuRows = [];
    const menuDefs = [
      ["show_search", "Поиск"], ["show_sort", "Все по порядку"], ["show_tv", "ТВ"],
      ["show_collections", "Подборки"],
      ...CONTENT_TYPES.map((ct) => [ct.show, ct.title]),
    ];
    for (const [key, label] of menuDefs) {
      menuChecks[key] = mkCheck(s[key]);
      menuRows.push(el("label", { text: label }), menuChecks[key]);
    }

    const grid = el("div", { class: "settings-grid" }, [
      el("div", { class: "settings-section", text: "Воспроизведение" }),
      el("label", { text: "Качество видео" }), quality,
      el("label", { text: "Тип потока" }), stream,
      el("label", { text: "Расположение CDN" }), loc,
      el("label", { text: "Спрашивать качество перед стартом" }), askQ,
      el("div", { class: "settings-section", text: "Сеть" }),
      el("label", { text: "Использовать системный прокси" }), useProxy,
      el("div", { class: "settings-section", text: "Списки" }),
      el("label", { text: "Сортировка" }), sortBy,
      el("label", { text: "Направление" }), sortDir,
      el("label", { text: "Исключить аниме" }), exclAnime,
      el("label", { text: "Помечать контент с рекламой (!)" }), markAdvert,
      el("div", { class: "settings-section", text: "Поиск" }),
      el("label", { text: "Размер истории поиска" }), histQty,
      el("div", { class: "settings-section", text: "Пункты меню" }),
      ...menuRows,
    ]);

    const ok = await Dialogs.show({
      title: "Настройки",
      bodyNodes: grid,
      width: 520,
      buttons: [
        { label: "OK", primary: true, value: true },
        { label: "Отмена", value: false },
      ],
    });
    if (!ok) return;
    const patch = {
      video_quality: quality.value,
      stream_type: stream.value,
      loc: loc.value,
      ask_quality: askQ.checked,
      use_system_proxy: useProxy.checked,
      sort_by: sortBy.value,
      sort_direction: sortDir.value,
      exclude_anime: exclAnime.checked,
      mark_advert: markAdvert.checked,
      history_max_qty: Number(histQty.value),
    };
    for (const [key, cb] of Object.entries(menuChecks)) patch[key] = cb.checked;
    await API.saveSettings(patch);
    this.buildSidebar();
    toast("Настройки сохранены");
  },
};

window.addEventListener("DOMContentLoaded", () => App.init());

// report progress before the window closes (best effort)
window.addEventListener("beforeunload", () => {
  if (Player.current) Player._sendMarktime();
});

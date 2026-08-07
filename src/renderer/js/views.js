"use strict";

/**
 * Library views + navigation stack (kodi.kino.pub screens, MPC chrome).
 */

const Nav = {
  stack: [],

  push(route) {
    if (this.stack.length) {
      this.stack[this.stack.length - 1].scroll = $("#content").scrollTop;
    }
    this.stack.push(route);
    Views.render(route);
  },

  replace(route) {
    // no scroll-save here: push() would record the outgoing view's scroll into
    // the route below the one being replaced, corrupting its saved position
    this.stack.pop();
    this.stack.push(route);
    Views.render(route);
  },

  back() {
    if (this.stack.length <= 1) return;
    this.stack.pop();
    const route = this.stack[this.stack.length - 1];
    Views.render(route).then(() => {
      if (route.scroll) $("#content").scrollTop = route.scroll;
    });
  },

  home() {
    this.stack = [];
    this.push({ name: "home" });
  },

  current() {
    return this.stack[this.stack.length - 1];
  },
};

const Views = {
  async render(route) {
    const content = $("#content");
    content.innerHTML = "";
    content.append(el("div", { class: "spinner" }));
    App.setBreadcrumb(route);
    App.highlightSidebar(route);
    try {
      await this[`view_${route.name}`](route, content);
    } catch (e) {
      console.error(e);
      content.innerHTML = "";
      content.append(el("div", { class: "center-note", text: `Ошибка: ${e.message || e}` }));
    }
  },

  _fill(content, nodes) {
    content.innerHTML = "";
    content.append(...[].concat(nodes).filter(Boolean));
  },

  /* ------------------------------------------------------------ home --- */

  async view_home(route, content) {
    const s = API.settings;
    const tiles = [];
    const add = (title, ico, route_) =>
      tiles.push(
        el("div", { class: "tile", onclick: () => Nav.push(route_) }, [
          el("div", { style: "font-size:34px", text: ico }),
          el("div", { class: "tile-title", text: title }),
        ])
      );
    tiles.push(
      el("div", { class: "tile", onclick: () => App.showProfile() }, [
        el("div", { style: "font-size:34px", text: "👤" }),
        el("div", { class: "tile-title", text: "Профиль" }),
      ])
    );
    if (s.show_search) add("Поиск", "🔍", { name: "search", params: { type: "all" } });
    add("Закладки", "📁", { name: "bookmarks" });
    add("Я смотрю", "▶", { name: "watching_serials" });
    add("Недосмотренные", "⏸", { name: "watching_movies" });
    if (s.show_sort) add("Все по порядку", "↕", { name: "sorted_all" });
    if (s.show_tv) add("ТВ", "📺", { name: "tv" });
    if (s.show_collections) add("Подборки", "🗂", { name: "collections" });
    for (const ct of CONTENT_TYPES) {
      if (s[ct.show]) add(ct.title, "🎬", { name: "section", params: { ct } });
    }
    this._fill(content, el("div", { class: "tile-row" }, tiles));
  },

  /* --------------------------------------------------------- sections --- */

  // Content-type section with heading tabs: Свежие / Горячие / Популярные /
  // Алфавит / Жанры / Сортировка (like the add-on's headings screen).
  async view_section(route, content) {
    const { ct } = route.params;
    const heading = route.params.heading || "fresh";
    const tabs = [
      { key: "fresh", label: "Свежие" },
      { key: "hot", label: "Горячие" },
      { key: "popular", label: "Популярные" },
      { key: "alphabet", label: "Алфавит" },
      { key: "genres", label: "Жанры" },
      { key: "sort", label: "Сортировка" },
    ];
    const tabRow = el("div", { class: "headings" }, tabs.map((t) =>
      el("div", {
        class: `heading-tab${t.key === heading ? " active" : ""}`,
        text: t.label,
        onclick: () => Nav.replace({ ...route, params: { ...route.params, heading: t.key, page: 1, letter: undefined, genre: undefined } }),
      })
    ));

    if (heading === "alphabet" && !route.params.letter) {
      const letters = [..."АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЫЭЮЯABCDEFGHIJKLMNOPQRSTUVWXYZ"];
      this._fill(content, [tabRow, el("div", { class: "rows", style: "padding:10px" },
        letters.map((L) => el("div", {
          class: "row letter",
          text: L,
          onclick: () => Nav.push({ ...route, params: { ...route.params, letter: L, page: 1 } }),
        }))
      )]);
      return;
    }

    if (heading === "genres" && !route.params.genre) {
      const genres = await API.getGenres(ct.type);
      this._fill(content, [tabRow, el("div", { class: "rows" },
        genres.map((g) => el("div", {
          class: "row",
          onclick: () => Nav.push({ ...route, params: { ...route.params, genre: g, page: 1 } }),
        }, [el("span", { class: "row-main", text: g.title })]))
      )]);
      return;
    }

    // item listings
    const params = { type: ct.type, page: route.params.page || 1 };
    if (route.params.start_from) params.start_from = route.params.start_from;
    let endpointHeading = null;
    if (["fresh", "hot", "popular"].includes(heading)) {
      endpointHeading = heading;
    } else {
      Object.assign(params, API.sortingParams());
      if (route.params.letter) params.letter = route.params.letter;
      if (route.params.genre) params.genre = route.params.genre.id;
    }

    let extraBar = null;
    if (heading === "sort") extraBar = this._sortControls(route);

    const resp = await API.getItems(endpointHeading, params);
    this._fill(content, [
      tabRow,
      extraBar,
      this.itemsGrid(resp.items),
      this.paginationRow(resp.pagination, route),
    ]);
  },

  _sortControls(route) {
    const sel = el("select", {}, SORT_OPTIONS.map((o) =>
      el("option", { value: o.value, text: o.label })));
    sel.value = API.settings.sort_by;
    const dir = el("select", {}, [
      el("option", { value: "desc", text: "По убыванию" }),
      el("option", { value: "asc", text: "По возрастанию" }),
    ]);
    dir.value = API.settings.sort_direction;
    const apply = async () => {
      await API.saveSettings({ sort_by: sel.value, sort_direction: dir.value });
      Nav.replace({ ...route, params: { ...route.params, page: 1 } });
    };
    sel.onchange = apply;
    dir.onchange = apply;
    return el("div", { class: "headings", style: "top:auto" }, [sel, dir]);
  },

  // "Все по порядку" from the main menu: /items over all types with sorting
  async view_sorted_all(route, content) {
    const params = { page: route.params?.page || 1, ...API.sortingParams() };
    const bar = this._sortControls(route);
    const resp = await API.getItems(null, params);
    this._fill(content, [bar, this.itemsGrid(resp.items), this.paginationRow(resp.pagination, route)]);
  },

  /* ----------------------------------------------------------- search --- */

  async view_search(route, content) {
    const type = route.params?.type || "all";
    const history = API.settings.search_history || [];
    const inp = el("input", { type: "text", placeholder: "Название…" });
    inp.style.cssText = "width:340px;padding:6px 10px;border:1px solid #a0a0a0;font-size:13px";
    const go = async () => {
      const title = inp.value.trim();
      if (!title) return;
      await kp.history.add(title);
      API.settings.search_history = await kp.settings.get().then((s) => s.search_history);
      Nav.push({ name: "search_results", params: { type, title } });
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    const rows = history.map((h) =>
      el("div", { class: "row", onclick: () => Nav.push({ name: "search_results", params: { type, title: h } }) }, [
        el("span", { class: "watched-flag", text: "🕘" }),
        el("span", { class: "row-main", text: h }),
      ])
    );
    this._fill(content, [
      el("div", { style: "padding:16px;display:flex;gap:8px" }, [
        inp,
        el("button", { class: "btn primary", text: "Искать", onclick: go }),
        el("button", {
          class: "btn", text: "Очистить историю",
          onclick: async () => {
            if (await Dialogs.confirm("kino.pub", "Очистить историю поиска?")) {
              await kp.history.clear();
              API.settings.search_history = [];
              Nav.replace(route);
            }
          },
        }),
      ]),
      rows.length ? el("div", { class: "rows" }, rows) : null,
    ]);
    setTimeout(() => inp.focus(), 0);
  },

  async view_search_results(route, content) {
    const { type, title } = route.params;
    const params = { title, page: route.params.page || 1, ...API.sortingParams() };
    if (type !== "all") params.type = type;
    const resp = await API.getItems(null, params);
    if (!resp.items.length) {
      this._fill(content, el("div", { class: "center-note", text: "Ничего не найдено" }));
      return;
    }
    this._fill(content, [this.itemsGrid(resp.items), this.paginationRow(resp.pagination, route)]);
  },

  /* -------------------------------------------------------- item lists --- */

  itemsGrid(items) {
    return el("div", { class: "grid" }, items.map((item) => this.itemCard(item)));
  },

  itemCard(item) {
    const posters = item.posters || {};
    const card = el("div", { class: "card" }, [
      el("img", { class: "poster", src: posters.medium || posters.small || "", loading: "lazy" }),
      item.imdb_rating ? el("span", { class: "badge", text: `IMDB ${Number(item.imdb_rating).toFixed(1)}` }) : null,
      item.kinopoisk_rating ? el("span", { class: "badge kp", text: `КП ${Number(item.kinopoisk_rating).toFixed(1)}` }) : null,
      item.new ? el("span", { class: "new-count", text: `+${item.new}` }) : null,
      el("div", { class: "card-title", text: item.title + (item.advert && API.settings.mark_advert ? " (!)" : "") }),
      el("div", { class: "card-sub", text: [item.year, (item.genres || []).slice(0, 2).map((g) => g.title).join(", ")].filter(Boolean).join(" · ") }),
    ]);
    card.onclick = () => Nav.push({ name: "detail", params: { id: item.id } });
    card.oncontextmenu = (e) => {
      e.preventDefault();
      this.itemContextMenu(e, item);
    };
    return card;
  },

  itemContextMenu(e, item) {
    const items = [
      { label: "Открыть", action: () => Nav.push({ name: "detail", params: { id: item.id } }) },
      { label: "Смотреть", action: () => Playback.playItem(item.id) },
      "-",
    ];
    if (isSerialType(item)) {
      const sub = item.subscribed || item.in_watchlist || item.from_watching;
      items.push({
        label: sub ? "Не буду смотреть" : "Буду смотреть",
        action: async () => {
          await API.toggleWatchlist(item.id);
          toast(sub ? "Сериал удалён из списка отслеживаемых" : "Сериал добавлен в список отслеживаемых");
          Views.render(Nav.current());
        },
      });
    } else {
      items.push({
        label: "Просмотрено / не просмотрено",
        action: async () => {
          await API.toggleWatched({ id: item.id, video: isMultiType(item) ? undefined : 1 });
          toast("Статус просмотра изменён");
        },
      });
    }
    items.push(
      { label: "Изменить закладки…", action: () => Playback.editBookmarks(item.id) },
      "-",
      { label: "Комментарии kino.pub", action: () => Playback.showComments(item.id) },
      { label: "Похожие фильмы", action: () => Nav.push({ name: "similar", params: { id: item.id, title: item.title } }) },
      item.trailer ? { label: "Трейлер", action: () => Playback.playTrailer(item.id, item.title) } : null,
    );
    CtxMenu.show(e.clientX, e.clientY, items.filter(Boolean));
  },

  paginationRow(pagination, route) {
    if (!pagination || Number(pagination.total) <= 1) return null;
    const cur = Number(pagination.current);
    const total = Number(pagination.total);
    const goto = (page, start_from) =>
      Nav.replace({ ...route, params: { ...route.params, page, start_from } });
    return el("div", { class: "pagination" }, [
      el("button", { text: "← Назад", disabled: cur <= 1 ? "" : undefined, onclick: () => goto(cur - 1) }),
      el("button", {
        text: "Вперёд →",
        disabled: cur >= total ? "" : undefined,
        onclick: () => goto(cur + 1, pagination.start_from),
      }),
      el("span", { class: "page-info", text: `Страница ${cur} из ${total}` }),
    ]);
  },

  /* ------------------------------------------------------------ detail --- */

  async view_detail(route, content) {
    const item = await API.getItem(route.params.id);
    const posters = item.posters || {};
    const serial = isSerialType(item);
    const multi = isMultiType(item);

    let watching = null;
    try {
      watching = await API.getWatchingInfo(item.id);
    } catch (e) { /* not tracked yet */ }

    const fields = el("div", { class: "fields" }, [
      item.genres?.length ? el("div", {}, [el("b", { text: "Жанр: " }), item.genres.map((g) => g.title).join(", ")]) : null,
      item.countries?.length ? el("div", {}, [el("b", { text: "Страна: " }), item.countries.map((c) => c.title).join(", ")]) : null,
      item.director ? el("div", {}, [el("b", { text: "Режиссёр: " }), item.director]) : null,
      item.cast ? el("div", {}, [el("b", { text: "В ролях: " }), item.cast]) : null,
      serial ? el("div", {}, [el("b", { text: "Статус: " }), item.finished ? "завершён" : "в эфире"]) : null,
    ]);

    const actions = el("div", { class: "actions" });
    if (!serial && !multi) {
      actions.append(el("button", { class: "btn primary", text: "▶ Смотреть", onclick: () => Playback.playMovie(item, watching) }));
    }
    if (item.trailer) {
      actions.append(el("button", { class: "btn", text: "Трейлер", onclick: () => Playback.playTrailer(item.id, item.title) }));
    }
    if (serial) {
      const sub = item.subscribed || item.in_watchlist;
      actions.append(el("button", {
        class: "btn",
        text: sub ? "Не буду смотреть" : "Буду смотреть",
        onclick: async (e) => {
          await API.toggleWatchlist(item.id);
          e.target.textContent = e.target.textContent === "Буду смотреть" ? "Не буду смотреть" : "Буду смотреть";
          toast("Список отслеживаемых обновлён");
        },
      }));
    }
    actions.append(
      el("button", { class: "btn", text: "Закладки…", onclick: () => Playback.editBookmarks(item.id) }),
      el("button", { class: "btn", text: "Комментарии", onclick: () => Playback.showComments(item.id) }),
      el("button", { class: "btn", text: "Похожие", onclick: () => Nav.push({ name: "similar", params: { id: item.id, title: item.title } }) }),
    );

    const ratings = el("div", { class: "ratings" }, [
      item.imdb_rating ? el("span", { text: `IMDB: ${Number(item.imdb_rating).toFixed(1)}` }) : null,
      item.kinopoisk_rating ? el("span", { text: `Кинопоиск: ${Number(item.kinopoisk_rating).toFixed(1)}` }) : null,
      item.rating_votes ? el("span", { text: `Голосов: ${item.rating_votes}` }) : null,
    ]);

    // item.duration is an object {average, total} in detail responses
    const duration = item.duration?.average ?? item.duration;

    const head = el("div", { class: "detail" }, [
      el("div", { class: "poster-col" }, [el("img", { src: posters.big || posters.medium || "" })]),
      el("div", { class: "info-col" }, [
        el("h1", { text: item.title }),
        el("div", { class: "meta", text: [item.year, duration ? fmtTime(duration) : null].filter(Boolean).join(" · ") }),
        ratings,
        el("div", { class: "plot", text: item.plot || "" }),
        fields,
        actions,
      ]),
    ]);

    const blocks = [head];
    if (serial) blocks.push(...this._seasonBlocks(item, watching));
    if (multi) blocks.push(this._multiBlock(item, watching));
    this._fill(content, blocks);
  },

  _seasonBlocks(item, watching) {
    const blocks = [];
    (item.seasons || []).forEach((season, si) => {
      const wSeason = watching?.seasons?.[si];
      const rows = (season.episodes || []).map((ep, ei) => {
        const wEp = wSeason?.episodes?.[ei];
        const label = `s${String(si + 1).padStart(2, "0")}e${String(ei + 1).padStart(2, "0")}` +
          (ep.title ? ` | ${ep.title}` : "");
        const row = el("div", { class: "row" }, [
          el("span", { class: "watched-flag", text: Number(wEp?.status) === 1 ? "✓" : "" }),
          el("span", { class: "row-main", text: label }),
          wEp?.time > 0 && Number(wEp.status) !== 1
            ? el("span", { class: "row-note", text: `⏸ ${fmtTime(wEp.time)}` }) : null,
          el("span", { class: "row-note", text: fmtTime(ep.duration) }),
        ]);
        row.onclick = () => Playback.playSerial(item, watching, si, ei);
        row.oncontextmenu = (e) => {
          e.preventDefault();
          CtxMenu.show(e.clientX, e.clientY, [
            { label: "Смотреть", action: () => Playback.playSerial(item, watching, si, ei) },
            {
              label: Number(wEp?.status) === 1 ? "Отметить непросмотренным" : "Отметить просмотренным",
              action: async () => {
                await API.toggleWatched({ id: item.id, season: si + 1, video: ei + 1 });
                Views.render(Nav.current());
              },
            },
          ]);
        };
        return row;
      });
      blocks.push(el("div", { class: "season-block" }, [
        el("h2", {}, [
          `Сезон ${si + 1}`,
          Number(wSeason?.status) === 1 ? el("span", { class: "row-note", text: "✓ просмотрен" }) : null,
        ]),
        el("div", { class: "rows" }, rows),
      ]));
    });
    return blocks;
  },

  _multiBlock(item, watching) {
    const rows = (item.videos || []).map((video, vi) => {
      const wVid = watching?.videos?.[vi];
      const label = `e${String(vi + 1).padStart(2, "0")}` + (video.title ? ` | ${video.title}` : "");
      const row = el("div", { class: "row" }, [
        el("span", { class: "watched-flag", text: Number(wVid?.status ?? video.watched) === 1 ? "✓" : "" }),
        el("span", { class: "row-main", text: label }),
        el("span", { class: "row-note", text: fmtTime(video.duration) }),
      ]);
      row.onclick = () => Playback.playMulti(item, watching, vi);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        CtxMenu.show(e.clientX, e.clientY, [
          { label: "Смотреть", action: () => Playback.playMulti(item, watching, vi) },
          {
            label: "Просмотрено / не просмотрено",
            action: async () => {
              await API.toggleWatched({ id: item.id, video: vi + 1 });
              Views.render(Nav.current());
            },
          },
        ]);
      };
      return row;
    });
    return el("div", { class: "season-block" }, [el("h2", { text: "Серии" }), el("div", { class: "rows" }, rows)]);
  },

  async view_similar(route, content) {
    const items = await API.getSimilar(route.params.id);
    if (!items.length) {
      this._fill(content, el("div", { class: "center-note", text: "Здесь пусто" }));
      return;
    }
    this._fill(content, this.itemsGrid(items));
  },

  /* --------------------------------------------------------- bookmarks --- */

  async view_bookmarks(route, content) {
    const folders = await API.getBookmarkFolders();
    const tiles = folders.map((f) => {
      const tile = el("div", { class: "tile", onclick: () => Nav.push({ name: "bookmark_folder", params: { folder: f } }) }, [
        el("div", { style: "font-size:34px", text: "📁" }),
        el("div", { class: "tile-title", text: f.title }),
        el("div", { class: "tile-sub", text: `${f.views ?? 0} просм.` }),
      ]);
      tile.oncontextmenu = (e) => {
        e.preventDefault();
        CtxMenu.show(e.clientX, e.clientY, [{
          label: "Удалить папку",
          action: async () => {
            if (await Dialogs.confirm("Закладки", `Удалить папку «${f.title}»?`)) {
              await API.removeBookmarkFolder(f.id);
              Views.render(Nav.current());
            }
          },
        }]);
      };
      return tile;
    });
    tiles.unshift(el("div", {
      class: "tile",
      onclick: async () => {
        const title = await Dialogs.input("Название папки закладок");
        if (title) {
          await API.createBookmarkFolder(title);
          Views.render(Nav.current());
        }
      },
    }, [
      el("div", { style: "font-size:34px", text: "＋" }),
      el("div", { class: "tile-title", text: "Создать папку" }),
    ]));
    this._fill(content, el("div", { class: "tile-row" }, tiles));
  },

  async view_bookmark_folder(route, content) {
    const resp = await API.getBookmarkFolder(route.params.folder.id, { page: route.params.page || 1 });
    this._fill(content, [
      this.itemsGrid(resp.items || []),
      this.paginationRow(resp.pagination, route),
    ]);
  },

  /* ---------------------------------------------------------- watching --- */

  async view_watching_serials(route, content) {
    const items = await API.getWatchingSerials();
    if (!items.length) {
      this._fill(content, el("div", { class: "center-note", text: "Здесь пусто. Подпишитесь на сериал («Буду смотреть»)" }));
      return;
    }
    items.forEach((i) => (i.from_watching = true));
    this._fill(content, this.itemsGrid(items));
  },

  async view_watching_movies(route, content) {
    const ids = (await API.getWatchingMovies()).map((i) => i.id);
    if (!ids.length) {
      this._fill(content, el("div", { class: "center-note", text: "Здесь пусто" }));
      return;
    }
    // fetch full items in parallel batches of 8 (like the add-on's thread pool)
    const items = [];
    for (let i = 0; i < ids.length; i += 8) {
      const batch = await Promise.all(ids.slice(i, i + 8).map((id) => API.getItem(id).catch(() => null)));
      items.push(...batch.filter(Boolean));
    }
    const grid = el("div", { class: "grid" }, items.map((item) => {
      const card = this.itemCard(item);
      const w = item.videos?.[0]?.watching;
      const dur = item.videos?.[0]?.duration;
      if (w?.time > 0 && dur > 0) {
        const strip = el("div", { class: "progress-strip" });
        strip.style.width = `${Math.min(100, (w.time / dur) * 100)}%`;
        card.querySelector(".poster").after(strip);
      }
      return card;
    }));
    this._fill(content, grid);
  },

  /* ------------------------------------------------------- collections --- */

  async view_collections(route, content) {
    const sorting = route.params?.sorting || "created";
    const tabs = [
      { key: "created", label: "Свежие" },
      { key: "watchers", label: "Горячие" },
      { key: "views", label: "Популярные" },
    ];
    const tabRow = el("div", { class: "headings" }, tabs.map((t) =>
      el("div", {
        class: `heading-tab${t.key === sorting ? " active" : ""}`,
        text: t.label,
        onclick: () => Nav.replace({ ...route, params: { sorting: t.key, page: 1 } }),
      })
    ));
    const resp = await API.getCollections(`-${sorting}`, route.params?.page || 1);
    const grid = el("div", { class: "grid" }, (resp.items || []).map((c) =>
      el("div", { class: "card", onclick: () => Nav.push({ name: "collection", params: { id: c.id, title: c.title } }) }, [
        el("img", { class: "poster", src: c.posters?.medium || "", loading: "lazy" }),
        el("div", { class: "card-title", text: c.title }),
        el("div", { class: "card-sub", text: `${c.views ?? ""} просм.` }),
      ])
    ));
    this._fill(content, [tabRow, grid, this.paginationRow(resp.pagination, route)]);
  },

  async view_collection(route, content) {
    const items = await API.getCollection(route.params.id);
    this._fill(content, this.itemsGrid(items));
  },

  /* ---------------------------------------------------------------- tv --- */

  async view_tv(route, content) {
    const channels = await API.getTvChannels();
    const tiles = channels.map((ch) =>
      el("div", { class: "tile", onclick: () => Playback.playTv(ch) }, [
        el("img", { src: ch.logos?.s || "", loading: "lazy" }),
        el("div", { class: "tile-title", text: ch.title }),
      ])
    );
    this._fill(content, el("div", { class: "tile-row" }, tiles));
  },
};

/* ===================================================== playback helpers === */

const Playback = {
  /** Resolve an item id -> appropriate playback (movie/serial/multi detail). */
  async playItem(id) {
    const item = await API.getItem(id);
    if (isSerialType(item) || isMultiType(item)) {
      Nav.push({ name: "detail", params: { id } });
      return;
    }
    let watching = null;
    try { watching = await API.getWatchingInfo(id); } catch (e) { /* none */ }
    this.playMovie(item, watching);
  },

  playMovie(item, watching) {
    const video = item.videos?.[0];
    if (!video) {
      toast("Нет видеофайлов", { error: true });
      return;
    }
    const w = video.watching || watching?.videos?.[0] ||
      { time: 0, status: video.watched ? 1 : 0, duration: video.duration };
    Player.openQueue([{
      itemId: item.id,
      title: item.title,
      sub: null,
      video,
      season: null,
      number: 1,
      watching: { time: w.time || 0, status: w.status ?? 0, duration: w.duration || video.duration },
      kind: "movie",
    }], 0);
  },

  /** Flat queue of all episodes of all seasons; start at (si, ei). */
  playSerial(item, watching, si, ei) {
    const queue = [];
    let startIndex = 0;
    (item.seasons || []).forEach((season, s) => {
      (season.episodes || []).forEach((ep, e) => {
        const wEp = watching?.seasons?.[s]?.episodes?.[e];
        if (s === si && e === ei) startIndex = queue.length;
        queue.push({
          itemId: item.id,
          title: item.title,
          sub: `s${String(s + 1).padStart(2, "0")}e${String(e + 1).padStart(2, "0")}` +
            (ep.title ? ` · ${ep.title}` : ""),
          video: ep,
          season: s + 1,
          number: e + 1,
          watching: {
            time: wEp?.time || 0,
            status: wEp?.status ?? 0,
            duration: wEp?.duration || ep.duration,
          },
          kind: "episode",
        });
      });
    });
    Player.openQueue(queue, startIndex);
  },

  playMulti(item, watching, vi) {
    const queue = (item.videos || []).map((video, v) => {
      const wVid = watching?.videos?.[v];
      return {
        itemId: item.id,
        title: item.title,
        sub: `e${String(v + 1).padStart(2, "0")}` + (video.title ? ` · ${video.title}` : ""),
        video,
        season: null,
        number: v + 1,
        watching: {
          time: wVid?.time || 0,
          status: wVid?.status ?? video.watched ?? 0,
          duration: wVid?.duration || video.duration,
        },
        kind: "episode",
      };
    });
    Player.openQueue(queue, vi);
  },

  async playTrailer(id, title) {
    try {
      const trailer = await API.getTrailer(id);
      const files = trailer.files || [];
      const url = files.length ? files[0].url : trailer.url;
      if (!url) throw new Error("нет ссылки");
      Player.openQueue([{
        itemId: id,
        title: `Трейлер: ${title}`,
        sub: null,
        video: { files: files.map((f) => ({ quality: f.quality, url: { http: f.url } })), subtitles: [], duration: 0 },
        season: null,
        number: null,
        watching: { time: 0, status: 0, duration: 0 },
        kind: "trailer",
      }], 0);
    } catch (e) {
      toast(`Не удалось открыть трейлер: ${e.message}`, { error: true });
    }
  },

  playTv(channel) {
    Player.openQueue([{
      itemId: channel.id,
      title: channel.title,
      sub: null,
      video: { files: [{ quality: "auto", url: { hls: channel.stream } }], subtitles: [], duration: 0 },
      season: null,
      number: null,
      watching: { time: 0, status: 0, duration: 0 },
      kind: "tv",
    }], 0);
  },

  /* -------------------------------------------------------------- misc --- */

  async editBookmarks(itemId) {
    const [allFolders, itemFolders] = await Promise.all([
      API.getBookmarkFolders(),
      API.getItemFolders(itemId),
    ]);
    if (!allFolders.length) {
      const title = await Dialogs.input("Нет папок. Название новой папки:");
      if (!title) return;
      await API.createBookmarkFolder(title);
      return this.editBookmarks(itemId);
    }
    const inIds = new Set(itemFolders.map((f) => f.id));
    const chosen = await Dialogs.multiselect(
      "Папки закладок",
      allFolders.map((f) => ({ label: f.title, value: f.id, checked: inIds.has(f.id) }))
    );
    if (chosen === null) return;
    const chosenSet = new Set(chosen);
    for (const f of allFolders) {
      if (chosenSet.has(f.id) && !inIds.has(f.id)) await API.addBookmark(itemId, f.id);
      if (!chosenSet.has(f.id) && inIds.has(f.id)) await API.removeBookmark(itemId, f.id);
    }
    toast("Закладки изменены");
  },

  async showComments(itemId) {
    const resp = await API.getComments(itemId);
    const comments = resp.comments || [];
    const nodes = comments.length
      ? comments.map((c) => {
          const r = Number(c.rating);
          return el("div", { class: "comment" }, [
            el("div", { class: "c-head" }, [
              c.user?.name || "аноним",
              r > 0 ? el("span", { class: "pos", text: ` (+${r})` }) :
              r < 0 ? el("span", { class: "neg", text: ` (${r})` }) : null,
            ]),
            el("div", { class: "c-msg", text: c.message || "" }),
          ]);
        })
      : [el("div", { text: "Здесь пусто" })];
    Dialogs.show({
      title: `Комментарии «${resp.item?.title || ""}»`,
      bodyNodes: nodes,
      selectable: true,
      width: 560,
    });
  },
};

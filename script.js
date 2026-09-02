(() => {
  "use strict";

  const API_ROOT = "https://collectionapi.metmuseum.org/public/collection/v1";
  const DEFAULT_INTERVAL = 5 * 60 * 1000;
  const UI_HIDE_DELAY = 4500;
  const INFO_HIDE_DELAY = 8000;
  const RECENT_LIMIT = 35;
  const FETCH_TIMEOUT = 12000;
  const MAX_ATTEMPTS = 24;
  const MIN_LANDSCAPE_RATIO = 1.15;

  const CATEGORIES = {
    random: { queries: ["painting", "landscape", "portrait", "still life", "oil painting"] },
    impressionism: { queries: ["Impressionism", "Impressionist painting"] },
    landscapes: { queries: ["landscape painting", "landscape"] },
    portraits: { queries: ["portrait painting", "portrait"] },
    nature: { queries: ["flowers painting", "nature painting", "animals painting"] },
    japanese: { queries: ["Japanese art", "ukiyo-e"], departmentId: 6 },
    nineteenth: { queries: ["19th century painting", "nineteenth century painting"] },
    "van-gogh": { queries: ["Vincent van Gogh"] },
    monet: { queries: ["Claude Monet"] },
    rembrandt: { queries: ["Rembrandt"] }
  };

  const $ = (id) => document.getElementById(id);
  const elements = {
    app: $("app"), images: [$("artwork-a"), $("artwork-b")], welcome: $("welcome"), status: $("status-text"),
    info: $("artwork-info"), title: $("artwork-title"), details: $("artwork-details"), museum: $("artwork-museum"),
    previous: $("previous-button"), play: $("play-button"), next: $("next-button"), favorite: $("favorite-button"),
    fullscreen: $("fullscreen-button"), category: $("category-select"), interval: $("interval-select"), toast: $("toast")
  };

  const loadJSON = (key, fallback) => {
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
    catch { return fallback; }
  };

  const savedInterval = Number(localStorage.getItem("artScreen.interval"));
  const state = {
    current: null,
    activeImage: 0,
    nextArtworkPromise: null,
    previous: [],
    recent: loadJSON("artScreen.recent", []).map(Number).filter(Number.isFinite).slice(-RECENT_LIMIT),
    favorites: loadJSON("artScreen.favorites", []).filter((item) => item && item.objectID),
    category: localStorage.getItem("artScreen.category") || "random",
    interval: [60000, 300000, 600000, 1800000].includes(savedInterval) ? savedInterval : DEFAULT_INTERVAL,
    paused: localStorage.getItem("artScreen.paused") === "true",
    infoPinned: false,
    loading: false,
    generation: 0,
    slideshowTimer: 0,
    uiTimer: 0,
    infoTimer: 0,
    toastTimer: 0,
    idPools: new Map()
  };

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or full storage */ }
  }

  function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    return fetch(url, { signal: controller.signal, cache: "default" }).finally(() => clearTimeout(timer));
  }

  async function getJSON(url) {
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.json();
  }

  function normalizeArtwork(data) {
    const image = data.primaryImage || data.primaryImageSmall;
    if (!image) return null;
    return {
      objectID: Number(data.objectID),
      title: (data.title || "Sem título").replace(/^\s*\[|\]\s*$/g, ""),
      artist: data.artistDisplayName || data.culture || "Artista desconhecido",
      year: data.objectDate || "",
      museum: data.repository || "The Metropolitan Museum of Art",
      image,
      department: data.department || "",
      publicDomain: Boolean(data.isPublicDomain)
    };
  }

  function preloadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = async () => {
        try { if (image.decode) await image.decode(); } catch { /* already usable */ }
        if (image.naturalWidth / image.naturalHeight < MIN_LANDSCAPE_RATIO) {
          reject(new Error("Formato vertical não selecionado"));
          return;
        }
        resolve(src);
      };
      image.onerror = () => reject(new Error("Imagem indisponível"));
      image.src = src;
    });
  }

  async function searchIDs(category) {
    const config = CATEGORIES[category] || CATEGORIES.random;
    const query = config.queries[Math.floor(Math.random() * config.queries.length)];
    const params = new URLSearchParams({ hasImages: "true", q: query });
    if (config.departmentId) params.set("departmentId", String(config.departmentId));
    const result = await getJSON(`${API_ROOT}/search?${params}`);
    const ids = Array.isArray(result.objectIDs) ? result.objectIDs : [];
    return ids.sort(() => Math.random() - 0.5).slice(0, 400);
  }

  async function artworkFromFavorites(excluded) {
    const candidates = state.favorites.filter((item) => !excluded.has(Number(item.objectID)));
    const fallback = candidates.length ? candidates : state.favorites;
    if (!fallback.length) throw new Error("Nenhum favorito salvo");
    const saved = fallback[Math.floor(Math.random() * fallback.length)];
    const artwork = saved.image ? saved : normalizeArtwork(await getJSON(`${API_ROOT}/objects/${saved.objectID}`));
    if (!artwork) throw new Error("Favorito sem imagem");
    await preloadImage(artwork.image);
    return artwork;
  }

  async function findArtwork(category = state.category) {
    const excluded = new Set([...state.recent, state.current?.objectID].filter(Boolean).map(Number));
    if (category === "favorites") return artworkFromFavorites(excluded);

    let pool = state.idPools.get(category) || [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (!pool.length) {
        pool = await searchIDs(category);
        state.idPools.set(category, pool);
      }
      const objectID = Number(pool.pop());
      if (!objectID || excluded.has(objectID)) continue;
      try {
        const artwork = normalizeArtwork(await getJSON(`${API_ROOT}/objects/${objectID}`));
        if (!artwork) continue;
        await preloadImage(artwork.image);
        return artwork;
      } catch { /* try another object silently */ }
    }
    state.idPools.delete(category);
    throw new Error("Não foi possível preparar outra obra");
  }

  function prepareNext() {
    if (!state.current) return;
    const generation = state.generation;
    state.nextArtworkPromise = findArtwork().then((artwork) => {
      if (generation !== state.generation) throw new Error("Seleção alterada");
      return artwork;
    }).catch(() => null);
  }

  function updateInfo(artwork) {
    elements.title.textContent = artwork.title;
    elements.details.textContent = [artwork.artist, artwork.year].filter(Boolean).join(" · ");
    elements.museum.textContent = artwork.museum;
    showInfo();
  }

  function showInfo() {
    if (!state.current) return;
    elements.info.classList.add("is-visible");
    clearTimeout(state.infoTimer);
    if (!state.infoPinned) state.infoTimer = setTimeout(() => elements.info.classList.remove("is-visible"), INFO_HIDE_DELAY);
  }

  function hideInfo() {
    clearTimeout(state.infoTimer);
    elements.info.classList.remove("is-visible");
  }

  function renderFavorite() {
    const favorite = state.current && state.favorites.some((item) => Number(item.objectID) === state.current.objectID);
    elements.favorite.textContent = favorite ? "♥" : "♡";
    elements.favorite.classList.toggle("is-favorite", Boolean(favorite));
    elements.favorite.setAttribute("aria-pressed", String(Boolean(favorite)));
    elements.favorite.setAttribute("aria-label", favorite ? "Remover dos favoritos" : "Adicionar aos favoritos");
  }

  async function displayArtwork(artwork, { addToHistory = true } = {}) {
    if (!artwork) return false;
    const nextIndex = 1 - state.activeImage;
    const incoming = elements.images[nextIndex];
    const outgoing = elements.images[state.activeImage];
    incoming.src = artwork.image;
    incoming.alt = `${artwork.title}, ${artwork.artist}`;
    try { if (incoming.decode) await incoming.decode(); } catch { /* preloaded already */ }

    if (addToHistory && state.current) state.previous.push(state.current);
    state.current = artwork;
    state.recent = [...state.recent.filter((id) => id !== artwork.objectID), artwork.objectID].slice(-RECENT_LIMIT);
    saveJSON("artScreen.recent", state.recent);

    incoming.classList.add("is-active");
    outgoing.classList.remove("is-active");
    state.activeImage = nextIndex;
    elements.welcome.classList.add("is-hidden");
    updateInfo(artwork);
    renderFavorite();
    elements.previous.disabled = state.previous.length === 0;
    setTimeout(() => { if (!outgoing.classList.contains("is-active")) outgoing.removeAttribute("src"); }, 2800);
    scheduleSlideshow();
    prepareNext();
    return true;
  }

  async function goNext() {
    if (state.loading) return;
    state.loading = true;
    elements.next.disabled = true;
    try {
      const prepared = state.nextArtworkPromise ? await state.nextArtworkPromise : null;
      const artwork = prepared || await findArtwork();
      await displayArtwork(artwork);
    } catch {
      showToast(state.category === "favorites" ? "Marque algumas obras como favoritas primeiro" : "Tentando novamente em instantes…");
      scheduleRetry();
    } finally {
      state.loading = false;
      elements.next.disabled = false;
    }
  }

  async function goPrevious() {
    if (state.loading || !state.previous.length) return;
    state.loading = true;
    try {
      const artwork = state.previous.pop();
      state.generation += 1;
      state.nextArtworkPromise = null;
      await preloadImage(artwork.image);
      await displayArtwork(artwork, { addToHistory: false });
    } catch { showToast("A obra anterior não está mais disponível"); }
    finally { state.loading = false; elements.previous.disabled = state.previous.length === 0; }
  }

  function scheduleSlideshow() {
    clearTimeout(state.slideshowTimer);
    if (!state.paused && state.current) state.slideshowTimer = setTimeout(goNext, state.interval);
  }

  function scheduleRetry() {
    clearTimeout(state.slideshowTimer);
    if (!state.paused) state.slideshowTimer = setTimeout(goNext, 15000);
  }

  function setPaused(paused) {
    state.paused = paused;
    try { localStorage.setItem("artScreen.paused", String(paused)); } catch { /* ignore */ }
    elements.play.textContent = paused ? "▶" : "Ⅱ";
    elements.play.setAttribute("aria-label", paused ? "Continuar slideshow" : "Pausar slideshow");
    paused ? clearTimeout(state.slideshowTimer) : scheduleSlideshow();
    showToast(paused ? "Slideshow pausado" : "Slideshow ativo");
  }

  function showUI() {
    elements.app.classList.add("is-ui-visible");
    if (!state.infoPinned) showInfo();
    clearTimeout(state.uiTimer);
    state.uiTimer = setTimeout(() => elements.app.classList.remove("is-ui-visible"), UI_HIDE_DELAY);
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
  }

  function toggleFavorite() {
    if (!state.current) return;
    const index = state.favorites.findIndex((item) => Number(item.objectID) === state.current.objectID);
    if (index >= 0) {
      state.favorites.splice(index, 1);
      showToast("Removida dos favoritos");
    } else {
      state.favorites.push({ ...state.current });
      showToast("Adicionada aos favoritos");
    }
    saveJSON("artScreen.favorites", state.favorites);
    renderFavorite();
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { showToast("Use F11 para entrar em tela cheia"); }
  }

  async function changeCategory(category) {
    if (category === "favorites" && !state.favorites.length) {
      showToast("Você ainda não marcou favoritos");
      elements.category.value = state.category;
      return;
    }
    state.category = category;
    state.generation += 1;
    state.nextArtworkPromise = null;
    state.idPools.delete(category);
    try { localStorage.setItem("artScreen.category", category); } catch { /* ignore */ }
    await goNext();
  }

  function bindEvents() {
    let lastMove = 0;
    document.addEventListener("pointermove", () => {
      const now = Date.now();
      if (now - lastMove > 120) { lastMove = now; showUI(); }
    }, { passive: true });
    document.addEventListener("pointerdown", showUI, { passive: true });
    elements.previous.addEventListener("click", goPrevious);
    elements.next.addEventListener("click", goNext);
    elements.play.addEventListener("click", () => setPaused(!state.paused));
    elements.favorite.addEventListener("click", toggleFavorite);
    elements.fullscreen.addEventListener("click", toggleFullscreen);
    elements.category.addEventListener("change", (event) => changeCategory(event.target.value));
    elements.interval.addEventListener("change", (event) => {
      state.interval = Number(event.target.value);
      try { localStorage.setItem("artScreen.interval", String(state.interval)); } catch { /* ignore */ }
      scheduleSlideshow();
      showToast(`Troca a cada ${event.target.selectedOptions[0].textContent}`);
    });
    document.addEventListener("fullscreenchange", () => {
      const active = Boolean(document.fullscreenElement);
      elements.fullscreen.setAttribute("aria-label", active ? "Sair da tela cheia" : "Entrar em tela cheia");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearTimeout(state.slideshowTimer); else scheduleSlideshow();
    });
    document.addEventListener("keydown", (event) => {
      if (["SELECT", "BUTTON"].includes(document.activeElement?.tagName) && !["Escape", "f", "F"].includes(event.key)) return;
      if (event.key === "ArrowRight") { event.preventDefault(); goNext(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); goPrevious(); }
      else if (event.code === "Space") { event.preventDefault(); setPaused(!state.paused); }
      else if (event.key.toLowerCase() === "f") { event.preventDefault(); toggleFullscreen(); }
      else if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        const wasVisible = elements.info.classList.contains("is-visible");
        showUI();
        state.infoPinned = !wasVisible;
        state.infoPinned ? showInfo() : hideInfo();
        return;
      }
      showUI();
    });
  }

  async function init() {
    if (!CATEGORIES[state.category] && state.category !== "favorites") state.category = "random";
    if (state.category === "favorites" && !state.favorites.length) state.category = "random";
    elements.category.value = state.category;
    elements.interval.value = String(state.interval);
    elements.play.textContent = state.paused ? "▶" : "Ⅱ";
    elements.play.setAttribute("aria-label", state.paused ? "Continuar slideshow" : "Pausar slideshow");
    elements.previous.disabled = true;
    bindEvents();
    showUI();
    try {
      state.loading = true;
      const artwork = await findArtwork();
      await displayArtwork(artwork, { addToHistory: false });
    } catch {
      elements.status.textContent = "A galeria tentará se conectar novamente…";
      scheduleRetry();
    } finally { state.loading = false; }
  }

  init();
})();

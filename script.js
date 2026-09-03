(() => {
  "use strict";

  const API_ROOT = "https://collectionapi.metmuseum.org/public/collection/v1";
  const DEFAULT_INTERVAL = 5 * 60 * 1000;
  const UI_HIDE_DELAY = 4500;
  const INFO_HIDE_DELAY = 8000;
  const RECENT_LIMIT = 35;
  const FETCH_TIMEOUT = 12000;
  const MAX_ATTEMPTS = 24;
  const CANDIDATE_BATCH_SIZE = 3;
  const PRELOAD_QUEUE_SIZE = 4;
  const MIN_LANDSCAPE_RATIO = 1.15;
  const REJECTED_TYPES = /sculpture|photograph|architecture|installation|furniture|vessel|ceramic|armor|textile|jewelry|coin|medal|relief|bust|statue|metalwork|musical instrument|costume|basket|bowl|box|container|cup|dish|plate|weapon|tool|glassware|silverware|woodwork/i;
  const REJECTED_ORIGINS = /japan|japanese|islamic|arab|arabic/i;
  const REJECTED_CONTENT = /\b(nude|nudity|naked|erotic|bather|bathers|venus|aphrodite|adam and eve|bathsheba)\b/i;

  const CATEGORIES = {
    landscape: { queries: ["landscape painting", "landscape"] },
    impressionism: { queries: ["Impressionism", "Impressionist painting"] },
    nature: { queries: ["flowers painting", "nature painting", "botanical painting", "animals painting"] },
    portraits: { queries: ["portrait painting", "portrait"] },
    classics: {
      queries: ["European painting", "old master painting", "classical painting", "masterpiece painting"],
      params: { dateBegin: "1200", dateEnd: "1800" }
    },
    surprise: { queries: ["painting", "oil painting", "masterpiece painting", "Impressionism", "portrait painting", "landscape painting", "nature painting", "still life painting"] }
  };

  const $ = (id) => document.getElementById(id);
  const elements = {
    app: $("app"), images: [$("artwork-a"), $("artwork-b")], backdrops: [$("backdrop-a"), $("backdrop-b")],
    selection: $("selection-screen"), selectionStatus: $("selection-status"),
    start: $("start-button"), mood: $("mood-button"), moodSelect: $("mood-select"), moodTrigger: $("mood-trigger"),
    moodLabel: $("mood-label"), moodMenu: $("mood-menu"), moodOptions: [...document.querySelectorAll("[data-mood]")],
    favoriteMood: $("favorites-mood"),
    welcome: $("welcome"), status: $("status-text"),
    info: $("artwork-info"), title: $("artwork-title"), details: $("artwork-details"), museum: $("artwork-museum"),
    previous: $("previous-button"), play: $("play-button"), next: $("next-button"), favorite: $("favorite-button"),
    fullscreen: $("fullscreen-button"), interval: $("interval-select"), toast: $("toast")
  };

  const loadJSON = (key, fallback) => {
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
    catch { return fallback; }
  };

  const savedInterval = Number(localStorage.getItem("artScreen.interval"));
  const state = {
    current: null,
    activeImage: 0,
    nextArtworks: [],
    nextArtworkWaiters: [],
    queueFilling: false,
    previous: [],
    recent: loadJSON("artScreen.recent", []).map(Number).filter(Number.isFinite).slice(-RECENT_LIMIT),
    favorites: loadJSON("artScreen.favorites", []).filter((item) => item && item.objectID),
    category: localStorage.getItem("artScreen.category") || "surprise",
    experienceStarted: false,
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
    if (data.isPublicDomain !== true) return null;
    const image = data.primaryImage || data.primaryImageSmall;
    if (!image) return null;
    const classificationText = [data.classification, data.objectName, data.medium].filter(Boolean).join(" ");
    if (REJECTED_TYPES.test(classificationText)) return null;
    const originText = [data.culture, data.department, data.country, data.region, data.artistNationality].filter(Boolean).join(" ");
    if (REJECTED_ORIGINS.test(originText)) return null;
    const tagsText = Array.isArray(data.tags) ? data.tags.map((tag) => tag?.term).filter(Boolean).join(" ") : "";
    const contentText = [data.title, data.classification, data.objectName, data.medium, tagsText].filter(Boolean).join(" ");
    if (REJECTED_CONTENT.test(contentText)) return null;
    return {
      objectID: Number(data.objectID),
      title: (data.title || "Sem título").replace(/^\s*\[|\]\s*$/g, ""),
      artist: data.artistDisplayName || data.culture || "Artista desconhecido",
      year: data.objectDate || "",
      museum: data.repository || "The Metropolitan Museum of Art",
      image,
      department: data.department || "",
      classification: data.classification || data.objectName || "",
      publicDomain: Boolean(data.isPublicDomain),
      previewImage: data.primaryImageSmall || image
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
        resolve(image);
      };
      image.onerror = () => reject(new Error("Imagem indisponível"));
      image.src = src;
    });
  }

  async function searchIDs(category) {
    const config = CATEGORIES[category] || CATEGORIES.surprise;
    const query = config.queries[Math.floor(Math.random() * config.queries.length)];
    const params = new URLSearchParams({ hasImages: "true", q: query });
    Object.entries(config.params || {}).forEach(([key, value]) => params.set(key, value));
    const result = await getJSON(`${API_ROOT}/search?${params}`);
    const ids = Array.isArray(result.objectIDs) ? result.objectIDs : [];
    return ids.sort(() => Math.random() - 0.5).slice(0, 400);
  }

  async function artworkFromFavorites(excluded) {
    const publicDomainFavorites = state.favorites.filter((item) => item.publicDomain === true);
    const candidates = publicDomainFavorites.filter((item) => !excluded.has(Number(item.objectID)));
    const fallback = candidates.length ? candidates : publicDomainFavorites;
    if (!fallback.length) throw new Error("Nenhum favorito salvo");
    const saved = fallback[Math.floor(Math.random() * fallback.length)];
    const savedText = [saved.title, saved.classification, saved.objectName].filter(Boolean).join(" ");
    const artwork = saved.image && !REJECTED_TYPES.test(savedText) ? saved : normalizeArtwork(await getJSON(`${API_ROOT}/objects/${saved.objectID}`));
    if (!artwork) throw new Error("Favorito sem imagem");
    artwork.previewImage ||= artwork.image;
    artwork.preloadedPreview = await preloadImage(artwork.previewImage);
    return artwork;
  }

  async function loadCandidate(objectID) {
    const artwork = normalizeArtwork(await getJSON(`${API_ROOT}/objects/${objectID}`));
    if (!artwork) throw new Error("Obra sem imagem compativel");
    artwork.preloadedPreview = await preloadImage(artwork.previewImage);
    return artwork;
  }

  async function findArtwork(category = state.category, extraExcluded = []) {
    const excluded = new Set([...state.recent, state.current?.objectID, ...extraExcluded].filter(Boolean).map(Number));
    if (category === "favorites") return artworkFromFavorites(excluded);

    let pool = state.idPools.get(category) || [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += CANDIDATE_BATCH_SIZE) {
      if (!pool.length) {
        pool = await searchIDs(category);
        state.idPools.set(category, pool);
      }
      const candidateIDs = [];
      while (pool.length && candidateIDs.length < CANDIDATE_BATCH_SIZE) {
        const objectID = Number(pool.pop());
        if (objectID && !excluded.has(objectID)) candidateIDs.push(objectID);
      }
      if (!candidateIDs.length) continue;
      try {
        return await Promise.any(candidateIDs.map(loadCandidate));
      } catch { /* try another batch */ }
    }
    state.idPools.delete(category);
    throw new Error("Não foi possível preparar outra obra");
  }

  function resetPreparedQueue() {
    state.nextArtworks = [];
    state.nextArtworkWaiters.splice(0).forEach((resolve) => resolve(null));
  }

  async function fillArtworkQueue(generation) {
    const targetSize = state.category === "favorites"
      ? Math.min(PRELOAD_QUEUE_SIZE, Math.max(1, state.favorites.length))
      : PRELOAD_QUEUE_SIZE;
    let failed = false;
    try {
      while (generation === state.generation && (state.nextArtworks.length < targetSize || state.nextArtworkWaiters.length)) {
        const queuedIDs = state.nextArtworks.map((artwork) => artwork.objectID);
        const artwork = await findArtwork(state.category, queuedIDs);
        if (generation !== state.generation) return;
        const waiter = state.nextArtworkWaiters.shift();
        if (waiter) waiter(artwork);
        else state.nextArtworks.push(artwork);
      }
    } catch {
      failed = true;
      state.nextArtworkWaiters.splice(0).forEach((resolve) => resolve(null));
    } finally {
      state.queueFilling = false;
      const refillCurrentQueue = generation === state.generation && !failed && state.nextArtworks.length < targetSize;
      if (state.current && (state.nextArtworkWaiters.length || refillCurrentQueue)) {
        setTimeout(prepareNext, 0);
      }
    }
  }

  function prepareNext() {
    if (!state.current || state.queueFilling) return;
    const generation = state.generation;
    state.queueFilling = true;
    fillArtworkQueue(generation);
  }

  function takePreparedArtwork() {
    const artwork = state.nextArtworks.shift();
    if (artwork) {
      prepareNext();
      return Promise.resolve(artwork);
    }
    return new Promise((resolve) => {
      state.nextArtworkWaiters.push(resolve);
      prepareNext();
    });
  }

  function updateInfo(artwork) {
    elements.title.textContent = artwork.title;
    elements.details.textContent = [artwork.artist, artwork.year].filter(Boolean).join(" · ");
    elements.museum.textContent = "The Metropolitan Museum of Art, New York";
    showInfo();
  }

  async function upgradeActiveImage(artwork, imageElement) {
    if (!artwork.image || artwork.image === artwork.previewImage) return;
    if (state.current?.objectID !== artwork.objectID || elements.images[state.activeImage] !== imageElement) return;
    try {
      await preloadImage(artwork.image);
      if (state.current?.objectID !== artwork.objectID || elements.images[state.activeImage] !== imageElement) return;
      imageElement.src = artwork.image;
      elements.backdrops[state.activeImage].src = artwork.image;
      if (imageElement.decode) await imageElement.decode();
    } catch { /* keep the already visible preview */ }
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
    elements.favorite.classList.toggle("is-favorite", Boolean(favorite));
    elements.favorite.setAttribute("aria-pressed", String(Boolean(favorite)));
    elements.favorite.setAttribute("aria-label", favorite ? "Remover dos favoritos" : "Adicionar aos favoritos");
  }

  async function displayArtwork(artwork, { addToHistory = true } = {}) {
    if (!artwork) return false;
    const nextIndex = 1 - state.activeImage;
    const incoming = elements.images[nextIndex];
    const outgoing = elements.images[state.activeImage];
    const incomingBackdrop = elements.backdrops[nextIndex];
    const outgoingBackdrop = elements.backdrops[state.activeImage];
    artwork.previewImage ||= artwork.image;
    incoming.src = artwork.previewImage;
    incomingBackdrop.src = artwork.previewImage;
    incoming.alt = `${artwork.title}, ${artwork.artist}`;
    try { if (incoming.decode) await incoming.decode(); } catch { /* preloaded already */ }
    delete artwork.preloadedPreview;

    if (addToHistory && state.current) state.previous.push(state.current);
    state.current = artwork;
    state.recent = [...state.recent.filter((id) => id !== artwork.objectID), artwork.objectID].slice(-RECENT_LIMIT);
    saveJSON("artScreen.recent", state.recent);

    incoming.classList.add("is-active");
    outgoing.classList.remove("is-active");
    incomingBackdrop.classList.add("is-active");
    outgoingBackdrop.classList.remove("is-active");
    state.activeImage = nextIndex;
    elements.welcome.classList.add("is-hidden");
    updateInfo(artwork);
    renderFavorite();
    elements.previous.disabled = state.previous.length === 0;
    setTimeout(() => {
      if (outgoing.classList.contains("is-active")) return;
      outgoing.removeAttribute("src");
      outgoingBackdrop.removeAttribute("src");
    }, 2800);
    scheduleSlideshow();
    prepareNext();
    setTimeout(() => upgradeActiveImage(artwork, incoming), 1200);
    return true;
  }

  async function goNext() {
    if (state.loading) return;
    state.loading = true;
    elements.next.disabled = true;
    try {
      const prepared = await takePreparedArtwork();
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
      resetPreparedQueue();
      artwork.previewImage ||= artwork.image;
      artwork.preloadedPreview = await preloadImage(artwork.previewImage);
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
    elements.play.classList.toggle("is-paused", paused);
    elements.play.setAttribute("aria-label", paused ? "Continuar slideshow" : "Pausar slideshow");
    paused ? clearTimeout(state.slideshowTimer) : scheduleSlideshow();
    showToast(paused ? "Slideshow pausado" : "Slideshow ativo");
  }

  function showUI() {
    if (!state.experienceStarted) return;
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
    elements.favoriteMood.hidden = state.favorites.length === 0;
    renderFavorite();
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { showToast("Use F11 para entrar em tela cheia"); }
  }

  function setMoodMenu(open) {
    elements.moodMenu.hidden = !open;
    elements.moodTrigger.setAttribute("aria-expanded", String(open));
    elements.moodTrigger.classList.toggle("is-open", open);
    if (open) {
      const selected = elements.moodOptions.find((option) => option.dataset.mood === elements.moodSelect.value);
      (selected || elements.moodOptions.find((option) => !option.hidden))?.focus();
    }
  }

  function selectMood(option) {
    const value = option.dataset.mood;
    elements.moodSelect.value = value;
    elements.moodLabel.textContent = option.textContent;
    elements.moodOptions.forEach((item) => item.setAttribute("aria-selected", String(item === option)));
    elements.start.disabled = false;
    elements.selectionStatus.textContent = "";
    setMoodMenu(false);
    elements.moodTrigger.focus();
  }

  async function startExperience() {
    if (state.loading) return;
    const selected = elements.moodSelect.value;
    if (!CATEGORIES[selected] && selected !== "favorites") return;
    if (selected === "favorites" && !state.favorites.length) {
      elements.selectionStatus.textContent = "Save an artwork first.";
      return;
    }

    state.category = selected;
    state.generation += 1;
    state.previous = [];
    resetPreparedQueue();
    state.idPools.delete(selected);
    try { localStorage.setItem("artScreen.category", selected); } catch { /* ignore */ }

    state.loading = true;
    elements.start.disabled = true;
    elements.selectionStatus.textContent = "Preparing your gallery…";
    try {
      const artwork = await findArtwork(selected);
      state.experienceStarted = true;
      elements.app.classList.remove("is-selection-visible");
      elements.app.classList.add("is-ui-visible");
      elements.selection.setAttribute("aria-hidden", "true");
      await displayArtwork(artwork, { addToHistory: false });
      showUI();
    } catch {
      elements.selectionStatus.textContent = "The gallery could not connect. Please try again.";
    } finally {
      state.loading = false;
      elements.start.disabled = false;
      if (state.experienceStarted) elements.selectionStatus.textContent = "";
    }
  }

  function returnToSelection() {
    if (!state.experienceStarted) return;
    state.experienceStarted = false;
    state.generation += 1;
    clearTimeout(state.slideshowTimer);
    clearTimeout(state.uiTimer);
    resetPreparedQueue();
    hideInfo();
    elements.app.classList.remove("is-ui-visible");
    elements.app.classList.add("is-selection-visible");
    elements.selection.removeAttribute("aria-hidden");
    elements.moodSelect.value = state.category;
    elements.moodTrigger.focus();
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
    elements.start.addEventListener("click", startExperience);
    elements.moodTrigger.addEventListener("click", () => {
      setMoodMenu(elements.moodMenu.hidden);
    });
    elements.moodOptions.forEach((option) => option.addEventListener("click", () => selectMood(option)));
    document.addEventListener("pointerdown", (event) => {
      if (!elements.moodMenu.hidden && !event.target.closest(".mood-select-wrap")) setMoodMenu(false);
    });
    elements.mood.addEventListener("click", returnToSelection);
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
      if (event.key === "Escape" && !state.experienceStarted && !elements.moodMenu.hidden) {
        event.preventDefault();
        setMoodMenu(false);
        elements.moodTrigger.focus();
        return;
      }
      if (event.key === "Escape" && state.experienceStarted) {
        event.preventDefault();
        returnToSelection();
        return;
      }
      if (!state.experienceStarted) return;
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

  function init() {
    if (!CATEGORIES[state.category] && state.category !== "favorites") state.category = "surprise";
    if (state.category === "favorites" && !state.favorites.length) state.category = "surprise";
    elements.favoriteMood.hidden = state.favorites.length === 0;
    elements.moodSelect.value = state.category;
    const selectedMood = elements.moodOptions.find((option) => option.dataset.mood === state.category);
    elements.moodLabel.textContent = selectedMood?.textContent || "Select a mood";
    elements.moodOptions.forEach((option) => option.setAttribute("aria-selected", String(option === selectedMood)));
    elements.start.disabled = !state.category;
    elements.interval.value = String(state.interval);
    elements.play.classList.toggle("is-paused", state.paused);
    elements.play.setAttribute("aria-label", state.paused ? "Continuar slideshow" : "Pausar slideshow");
    elements.previous.disabled = true;
    bindEvents();
  }

  init();
})();

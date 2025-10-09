const API_ENDPOINT = "/api/articles";

const STORAGE_KEYS = {
    theme: "nfv-theme",
    history: "nfv-search-history"
};

const body = document.body;
const panelsContainer = document.getElementById("articlePanels");
const statusHeadline = document.getElementById("statusHeadline");
const lastRefreshed = document.getElementById("lastRefreshed");
const searchInput = document.getElementById("searchInput");
const refreshButton = document.getElementById("refreshButton");
const emptyState = document.getElementById("emptyState");
const errorState = document.getElementById("errorState");
const sortButtons = document.querySelectorAll(".pill-toggle__option");
const addFeedButton = document.getElementById("addFeedButton");
const addFeedForm = document.getElementById("addFeedForm");
const cancelAddFeed = document.getElementById("cancelAddFeed");
const feedInput = document.getElementById("feedInput");
const sourcesList = document.getElementById("sourcesList");
const themeToggle = document.getElementById("themeToggle");
const themeToggleLabel = themeToggle.querySelector(".theme-toggle__label");
const historyButton = document.getElementById("historyButton");
const historyPopup = document.getElementById("historyPopup");
const historyList = document.getElementById("historyList");
const historyCloseButton = document.getElementById("historyCloseButton");
const historyClearButton = document.getElementById("historyClearButton");
const floatingHeading = document.createElement("div");
floatingHeading.id = "floatingHeading";
floatingHeading.className = "floating-heading";
floatingHeading.hidden = true;

let sourceSequence = 0;
let cardObserver = null;
let panelProgressPanels = [];
let panelProgressRaf = null;
let panelProgressListenersAttached = false;

const MAX_HISTORY = 15;
const PANEL_GROUP_SIZE = 6;
const PANEL_ACTIVE_RATIO = 0.2;
const BENTO_LAYOUT = [
    { cols: 4, rows: 2, variant: "feature" },
    { cols: 2, rows: 2, variant: "spotlight" },
    { cols: 3, rows: 1, variant: "spotlight" },
    { cols: 3, rows: 1, variant: "spotlight" },
    { cols: 2, rows: 1, variant: "spotlight" },
    { cols: 2, rows: 1, variant: "spotlight" }
];
const DEFAULT_BENTO_CELL = { cols: 2, rows: 1, variant: "spotlight" };

const state = {
    items: [],
    sort: "latest",
    query: "",
    sources: [],
    feedErrors: [],
    searchHistory: loadSearchHistory()
};

function createSourceId() {
    sourceSequence += 1;
    return `source-${sourceSequence}`;
}

function createSource({ feed, title, url }) {
    return {
        id: createSourceId(),
        feed,
        title,
        url
    };
}

async function loadArticles(showSkeleton = true) {
    if (!state.sources.length) {
        state.items = [];
        state.feedErrors = [];
        refreshButton.disabled = false;
        if (cardObserver) {
            cardObserver.disconnect();
            cardObserver = null;
        }
        panelsContainer.innerHTML = "";
        toggleError(false);
        emptyState.hidden = true;
        statusHeadline.textContent = "Add a feed URL to load stories.";
        lastRefreshed.dateTime = "";
        lastRefreshed.textContent = "";
        updateSourcesList();
        detachPanelProgressListeners();
        floatingHeading.hidden = true;
        return;
    }

    if (showSkeleton) {
        const skeletonPanels = Math.max(1, Math.min(3, state.sources.length));
        renderSkeletonPanels(skeletonPanels);
        statusHeadline.textContent = "Loading fresh headlines…";
    }

    toggleError(false);
    emptyState.hidden = true;
    refreshButton.disabled = true;

    try {
        const results = await Promise.allSettled(
            state.sources.map(source => fetchSourceArticles(source))
        );
        const aggregated = [];
        const counts = new Map();
        const errors = [];

        results.forEach((result, index) => {
            const source = state.sources[index];
            if (result.status === "fulfilled") {
                const { items, title, url } = result.value;
                source.title = title;
                source.url = url;
                items.forEach(item => {
                    aggregated.push({
                        ...item,
                        sourceId: source.id,
                        sourceTitle: title,
                        sourceUrl: url
                    });
                    counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
                });
            } else {
                errors.push({ source, error: result.reason });
            }
        });

        state.items = aggregated;
        state.feedErrors = errors;
        updateSourcesList(counts);
        updateTimestamp(new Date());

        if (errors.length) {
            console.warn("Some feeds failed to load:", errors);
        }

        if (!aggregated.length && errors.length) {
            toggleError(true);
        } else {
            toggleError(false);
        }

        render();
    } catch (error) {
        console.error("Failed to load feeds:", error);
        state.items = [];
        state.feedErrors = [{ source: null, error }];
        toggleError(true);
        statusHeadline.textContent = "Unable to fetch feeds right now.";
        panelsContainer.innerHTML = "";
        updateSourcesList();
        detachPanelProgressListeners();
        floatingHeading.hidden = true;
    } finally {
        refreshButton.disabled = false;
    }
}

async function fetchSourceArticles(source) {
    if (!source.feed) {
        throw new Error("Feed URL is required for this source.");
    }
    const endpoint = `${API_ENDPOINT}?feed=${encodeURIComponent(source.feed)}`;

    const response = await fetch(endpoint);
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const sourceUrl = payload.source || source.feed || source.url;
    const title = deriveTitle(payload.title, sourceUrl);
    const items = Array.isArray(payload.items) ? payload.items : [];

    return { items, title, url: sourceUrl };
}

function render() {
    if (!state.sources.length) {
        if (cardObserver) {
            cardObserver.disconnect();
            cardObserver = null;
        }
        panelsContainer.innerHTML = "";
        toggleError(false);
        emptyState.hidden = true;
        statusHeadline.textContent = "Add a feed URL to load stories.";
        detachPanelProgressListeners();
        floatingHeading.hidden = true;
        return;
    }

    const filtered = filterAndSort(state.items);

    if (!filtered.length) {
        if (cardObserver) {
            cardObserver.disconnect();
            cardObserver = null;
        }
        panelsContainer.innerHTML = "";
        detachPanelProgressListeners();
        floatingHeading.hidden = true;

        if (state.items.length === 0 && state.feedErrors.length) {
            statusHeadline.textContent = "All feeds are currently unavailable.";
            emptyState.hidden = true;
            return;
        }

        toggleError(false);
        emptyState.hidden = false;
        statusHeadline.textContent = state.query
            ? `No matches for “${state.query}”`
            : "No stories available.";
        return;
    }

    toggleError(false);
    emptyState.hidden = true;
    if (cardObserver) {
        cardObserver.disconnect();
        cardObserver = null;
    }
    panelsContainer.innerHTML = "";

    const groups = groupArticlesBySource(filtered);
    groups.forEach(group => {
        const panelElement = createPanel(group.articles, group);
        panelElement.classList.add("is-active");
        panelsContainer.appendChild(panelElement);
    });
    setupCardObserver();
    initializePanelProgressTracking();

    const descriptor = state.query ? "stories matching your search" : "stories";
    let message = `Showing ${filtered.length} ${descriptor}`;
    if (state.sources.length > 1) {
        message += ` across ${state.sources.length} feeds`;
    }
    if (state.feedErrors.length) {
        message += ` • ${state.feedErrors.length} feed${state.feedErrors.length > 1 ? "s" : ""} failed`;
    }
    statusHeadline.textContent = message;
}

function filterAndSort(items) {
    const query = state.query.trim().toLowerCase();
    let working = [...items];

    if (query) {
        working = working.filter(article =>
            [article.title, article.description, article.author, article.sourceTitle, ...(article.categories || [])]
                .filter(Boolean)
                .some(value => value.toLowerCase().includes(query))
        );
    }

    if (state.sort === "latest") {
        working.sort((a, b) => {
            const dateA = a.published ? new Date(a.published) : null;
            const dateB = b.published ? new Date(b.published) : null;
            if (!dateA && !dateB) return 0;
            if (!dateA) return 1;
            if (!dateB) return -1;
            return dateB - dateA;
        });
    }

    return working;
}

function createPanel(articles, panelMeta = {}) {
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.dataset.sourceId = panelMeta.key ?? "";
    if (panelMeta.title) {
        const header = document.createElement("div");
        header.className = "panel__header";
        const eyebrow = document.createElement("span");
        eyebrow.className = "panel__eyebrow";
        eyebrow.textContent = "Feed focus";
        header.appendChild(eyebrow);
        const title = document.createElement("h3");
        title.className = "panel__title";
        title.textContent = panelMeta.title;
        header.appendChild(title);
        panel.appendChild(header);
    }

    const grid = document.createElement("div");
    grid.className = "panel__grid";
    articles.forEach((article, position) => {
        const card = createArticleCard(article);
        applyCardHierarchy(card, position);
        grid.appendChild(card);
    });
    if (articles.length === 1) {
        grid.classList.add("panel__grid--single");
    }
    panel.appendChild(grid);

    return panel;
}

function applyCardHierarchy(card, index) {
    const layout = BENTO_LAYOUT[index % BENTO_LAYOUT.length] ?? DEFAULT_BENTO_CELL;
    if (layout.variant === "feature") {
        card.classList.add("card--feature");
    } else {
        card.classList.add("card--spotlight");
    }
    card.style.setProperty("--card-col-span", layout.cols);
    card.style.setProperty("--card-row-span", layout.rows);
    card.style.setProperty("--card-order-index", index);
}

function groupArticlesBySource(items) {
    const groups = [];
    const index = new Map();
    items.forEach(article => {
        const fallbackKey =
            article.sourceUrl ||
            article.sourceTitle ||
            article.link ||
            `feed-${groups.length}`;
        const key = article.sourceId || fallbackKey;
        let group = index.get(key);
        if (!group) {
            const label = article.sourceTitle || deriveTitle("", article.sourceUrl);
            group = {
                key,
                title: label,
                url: article.sourceUrl,
                articles: []
            };
            index.set(key, group);
            groups.push(group);
        }
        group.articles.push(article);
    });
    return groups;
}

function setupCardObserver() {
    if (cardObserver) {
        cardObserver.disconnect();
    }
    cardObserver = new IntersectionObserver(
        entries => {
            entries.forEach(entry => {
                const isVisible = entry.intersectionRatio >= PANEL_ACTIVE_RATIO || entry.isIntersecting;
                if (isVisible) {
                    entry.target.classList.add("is-visible");
                    cardObserver.unobserve(entry.target);
                }
            });
        },
        {
            threshold: [0, PANEL_ACTIVE_RATIO, 0.65, 1],
            rootMargin: "0px 0px -10% 0px"
        }
    );

    panelsContainer.querySelectorAll(".card").forEach(card => {
        cardObserver.observe(card);
    });
}

function initializePanelProgressTracking() {
    panelProgressPanels = Array.from(panelsContainer.querySelectorAll(".panel"));
    if (!panelProgressPanels.length) {
        detachPanelProgressListeners();
        floatingHeading.hidden = true;
        return;
    }
    ensureFloatingHeadingMount();
    ensurePanelProgressListeners();
    requestPanelProgressUpdate();
}

function ensurePanelProgressListeners() {
    if (panelProgressListenersAttached) {
        return;
    }
    panelProgressListenersAttached = true;
    window.addEventListener("scroll", handlePanelProgressInvalidate, { passive: true });
    window.addEventListener("resize", handlePanelProgressInvalidate, { passive: true });
}

function detachPanelProgressListeners() {
    if (!panelProgressListenersAttached) {
        return;
    }
    window.removeEventListener("scroll", handlePanelProgressInvalidate);
    window.removeEventListener("resize", handlePanelProgressInvalidate);
    panelProgressListenersAttached = false;
    panelProgressPanels = [];
    if (panelProgressRaf !== null) {
        window.cancelAnimationFrame(panelProgressRaf);
        panelProgressRaf = null;
    }
}

function handlePanelProgressInvalidate() {
    requestPanelProgressUpdate();
}

function requestPanelProgressUpdate() {
    if (panelProgressRaf !== null) {
        return;
    }
    panelProgressRaf = window.requestAnimationFrame(() => {
        panelProgressRaf = null;
        updatePanelProgressValues();
    });
}

function updatePanelProgressValues() {
    if (!panelProgressPanels.length) {
        floatingHeading.hidden = true;
        return;
    }
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
    const anchor = viewportHeight * 0.35;
    let leadingPanel = null;
    let leadingScore = -Infinity;
    panelProgressPanels.forEach(panel => {
        const header = panel.querySelector(".panel__header");
        const headerRect = header?.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const headerHeight = headerRect ? Math.max(headerRect.height, 1) : Math.max(panelRect.height * 0.25, 1);
        const offset = anchor - panelRect.top;
        const progress = clamp01(offset / (headerHeight * 1.4));
        const gridProgress = clamp01((progress - 0.25) / 0.75);
        const title = header?.querySelector(".panel__title");
        const naturalWidth = title ? measureNaturalWidth(title) : 0;
        const availableWidth = Math.max(panel.clientWidth - 48, 120);
        const lengthScale = naturalWidth > 0 ? clamp(availableWidth / naturalWidth, 0.55, 1.05) : 1;
        const scaleBase = 1 + (1 - progress) * 0.45;
        const finalScale = clamp(scaleBase * lengthScale, 0.55, 1.55);
        panel.style.setProperty("--panel-progress", progress.toFixed(3));
        panel.style.setProperty("--panel-grid-progress", gridProgress.toFixed(3));
        panel.style.setProperty("--panel-title-scale", finalScale.toFixed(3));
        panel.classList.toggle("panel--grid-ready", gridProgress > 0.12);
        const panelScore = gridProgress + progress * 0.5;
        if (panelScore > leadingScore) {
            leadingScore = panelScore;
            leadingPanel = { panel, header, title };
        }
    });
    if (leadingPanel?.title) {
        floatingHeading.hidden = false;
        floatingHeading.textContent = leadingPanel.title.textContent ?? "";
    } else {
        floatingHeading.hidden = true;
    }
}

function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function measureNaturalWidth(element) {
    if (!element) {
        return 0;
    }
    const recorded = Number(element.dataset.naturalWidth);
    if (!Number.isNaN(recorded) && recorded > 0) {
        return recorded;
    }
    const width = element.scrollWidth;
    if (width > 0) {
        element.dataset.naturalWidth = String(width);
    }
    return width;
}

function ensureFloatingHeadingMount() {
    if (floatingHeading.isConnected) {
        return;
    }
    const mountTarget = document.querySelector(".feed-panel") || document.body;
    mountTarget.appendChild(floatingHeading);
}

function renderSkeletonPanels(panelCount = 1) {
    panelsContainer.innerHTML = "";
    for (let panelIndexValue = 0; panelIndexValue < panelCount; panelIndexValue += 1) {
        const panel = document.createElement("section");
        panel.className = "panel panel--loading is-active";
        const header = document.createElement("div");
        header.className = "panel__header";
        header.innerHTML = `
            <span class="panel__eyebrow">Feed focus</span>
            <h3 class="panel__title">Loading feed</h3>
        `;
        panel.appendChild(header);
        const grid = document.createElement("div");
        grid.className = "panel__grid";

        for (let cardIndex = 0; cardIndex < PANEL_GROUP_SIZE; cardIndex += 1) {
            const card = document.createElement("article");
            card.className = "card skeleton";
            applyCardHierarchy(card, cardIndex);

            const media = document.createElement("div");
            media.className = "card__media skeleton__block";
            card.appendChild(media);

            const body = document.createElement("div");
            body.className = "card__body";
            body.innerHTML = `
                <div class="skeleton__line"></div>
                <div class="skeleton__line short"></div>
                <div class="skeleton__line tiny"></div>
            `;
            card.appendChild(body);
            grid.appendChild(card);
        }

        panel.appendChild(grid);
        panelsContainer.appendChild(panel);
    }
    initializePanelProgressTracking();
}

function createArticleCard(article) {
    const card = document.createElement("article");
    card.className = "card";

    const media = document.createElement("div");
    media.className = "card__media";
    if (article.image) {
        const img = document.createElement("img");
        img.src = article.image;
        img.alt = article.title ? `Image for ${article.title}` : "Story image";
        media.appendChild(img);
    } else {
        media.classList.add("card__media--empty");
        const placeholder = document.createElement("span");
        placeholder.textContent = "No image";
        media.appendChild(placeholder);
    }
    card.appendChild(media);

    const bodySection = document.createElement("div");
    bodySection.className = "card__body";
    card.appendChild(bodySection);

    if (article.sourceTitle) {
        const sourceBadge = document.createElement("span");
        sourceBadge.className = "card__source";
        sourceBadge.textContent = article.sourceTitle;
        bodySection.appendChild(sourceBadge);
    }

    if (Array.isArray(article.categories) && article.categories.length) {
        const chips = document.createElement("div");
        chips.className = "card__chips";
        article.categories.slice(0, 3).forEach(category => {
            const chip = document.createElement("span");
            chip.className = "card__chip";
            chip.textContent = category;
            chips.appendChild(chip);
        });
        bodySection.appendChild(chips);
    }

    const heading = document.createElement("h2");
    heading.className = "card__title";
    heading.textContent = article.title || "Untitled story";
    bodySection.appendChild(heading);

    if (article.description) {
        const excerpt = document.createElement("p");
        excerpt.className = "card__excerpt";
        excerpt.textContent = truncate(article.description, 210);
        bodySection.appendChild(excerpt);
    }

    const meta = document.createElement("div");
    meta.className = "card__meta";

    if (article.author) {
        const author = document.createElement("span");
        author.textContent = `By ${article.author}`;
        meta.appendChild(author);
    }

    if (article.published) {
        const published = document.createElement("time");
        const publishedDate = new Date(article.published);
        if (!Number.isNaN(publishedDate.getTime())) {
            published.dateTime = publishedDate.toISOString();
            published.textContent = formatRelativeTime(publishedDate);
            meta.appendChild(published);
        }
    }

    if (meta.children.length) {
        bodySection.appendChild(meta);
    }

    if (article.link) {
        const link = document.createElement("a");
        link.className = "card__link";
        link.href = article.link;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.innerHTML = `
            Read full story
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 3l7 7-1.41 1.41L15 7.83V21h-2V7.83l-4.59 4.58L7 10l7-7z"/>
            </svg>
        `;
        bodySection.appendChild(link);
    }

    return card;
}

function truncate(text, length) {
    if (text.length <= length) {
        return text;
    }
    const trimmed = text.slice(0, length);
    const lastSpace = trimmed.lastIndexOf(" ");
    const safeSlice = lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed;
    return `${safeSlice}…`;
}

function formatRelativeTime(date) {
    const now = new Date();
    const diff = (date.getTime() - now.getTime()) / 1000;
    const abs = Math.abs(diff);

    const units = [
        { limit: 60, divisor: 1, unit: "second" },
        { limit: 3600, divisor: 60, unit: "minute" },
        { limit: 86400, divisor: 3600, unit: "hour" },
        { limit: 604800, divisor: 86400, unit: "day" },
        { limit: 2629800, divisor: 604800, unit: "week" },
        { limit: 31557600, divisor: 2629800, unit: "month" },
        { limit: Infinity, divisor: 31557600, unit: "year" }
    ];

    const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    for (const { limit, divisor, unit } of units) {
        if (abs < limit) {
            const value = Math.round(diff / divisor);
            return formatter.format(value, unit);
        }
    }
    return date.toLocaleString();
}

function updateTimestamp(date) {
    const iso = date.toISOString();
    lastRefreshed.dateTime = iso;
    lastRefreshed.textContent = `Updated ${date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    })}`;
}

function toggleError(isVisible) {
    errorState.hidden = !isVisible;
    if (isVisible) {
        emptyState.hidden = true;
    }
}

function deriveTitle(providedTitle, fallbackUrl) {
    if (providedTitle && providedTitle.trim()) {
        return providedTitle.trim();
    }
    if (!fallbackUrl) {
        return "Untitled feed";
    }
    try {
        const url = new URL(fallbackUrl);
        const hostname = url.hostname.replace(/^www\./i, "");
        return hostname || fallbackUrl;
    } catch {
        return fallbackUrl;
    }
}

function normalizeUrl(value) {
    try {
        return new URL(value).toString();
    } catch {
        return value.trim();
    }
}

function formatSourceLabel(source) {
    return source.title || deriveTitle("", source.feed || source.url);
}

function updateSourcesList(counts = new Map()) {
    sourcesList.innerHTML = "";
    if (!state.sources.length) {
        const pill = document.createElement("span");
        pill.className = "source-pill";
        pill.textContent = "No feeds added yet";
        sourcesList.appendChild(pill);
        return;
    }
    state.sources.forEach(source => {
        const pill = document.createElement("span");
        pill.className = "source-pill";
        const label = formatSourceLabel(source);
        const count = counts.get(source.id);
        pill.textContent = typeof count === "number" ? `${label} (${count})` : label;
        sourcesList.appendChild(pill);
    });
}

function toggleAddFeedForm(show) {
    addFeedForm.hidden = !show;
    addFeedButton.hidden = show;
    if (show) {
        feedInput.value = "";
        feedInput.focus();
    }
}

function addSource(feedUrl) {
    const normalized = normalizeUrl(feedUrl);
    const duplicate = state.sources.some(source => {
        const existing = normalizeUrl(source.feed || source.url || "");
        return existing.toLowerCase() === normalized.toLowerCase();
    });

    if (duplicate) {
        statusHeadline.textContent = "That feed is already in your mix.";
        toggleAddFeedForm(false);
        return;
    }

    state.sources.push(createSource({ feed: normalized, title: null, url: normalized }));
    updateSourcesList();
    toggleAddFeedForm(false);
    loadArticles(true);
}

function isValidUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function loadSearchHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.history);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.slice(0, MAX_HISTORY);
        }
    } catch (error) {
        console.warn("Unable to load search history:", error);
    }
    return [];
}

function persistSearchHistory() {
    try {
        localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.searchHistory));
    } catch (error) {
        console.warn("Unable to save search history:", error);
    }
}

function addSearchHistory(query) {
    const trimmed = query.trim();
    if (!trimmed) {
        return;
    }

    state.searchHistory = [
        trimmed,
        ...state.searchHistory.filter(item => item.toLowerCase() !== trimmed.toLowerCase())
    ].slice(0, MAX_HISTORY);

    persistSearchHistory();
    if (!historyPopup.hasAttribute("hidden")) {
        renderHistoryPopup();
    }
}

function renderHistoryPopup() {
    historyList.innerHTML = "";

    if (!state.searchHistory.length) {
        const emptyItem = document.createElement("li");
        emptyItem.className = "history-popup__item";
        emptyItem.textContent = "No searches yet.";
        historyList.appendChild(emptyItem);
        return;
    }

    state.searchHistory.forEach(entry => {
        const li = document.createElement("li");
        li.className = "history-popup__item";
        const span = document.createElement("span");
        span.textContent = entry;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Load";
        button.addEventListener("click", () => {
            searchInput.value = entry;
            state.query = entry;
            render();
            closeHistoryPopup();
        });
        li.appendChild(span);
        li.appendChild(button);
        historyList.appendChild(li);
    });
}

function openHistoryPopup() {
    renderHistoryPopup();
    historyPopup.removeAttribute("hidden");
    historyButton.setAttribute("aria-expanded", "true");
}

function closeHistoryPopup() {
    historyPopup.setAttribute("hidden", "");
    historyButton.setAttribute("aria-expanded", "false");
}

function loadThemePreference() {
    try {
        const stored = localStorage.getItem(STORAGE_KEYS.theme);
        if (stored === "light" || stored === "dark") {
            return stored;
        }
    } catch (error) {
        console.warn("Unable to load theme preference:", error);
    }
    return body.dataset.theme || "dark";
}

function applyTheme(theme) {
    body.dataset.theme = theme;
    themeToggleLabel.textContent = theme === "dark" ? "Switch to light" : "Switch to dark";
    try {
        localStorage.setItem(STORAGE_KEYS.theme, theme);
    } catch (error) {
        console.warn("Unable to persist theme preference:", error);
    }
}

function toggleTheme() {
    const nextTheme = body.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
}

searchInput.addEventListener("input", event => {
    state.query = event.target.value;
    render();
});

searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        const value = event.currentTarget.value.trim();
        if (value) {
            addSearchHistory(value);
        }
    }
});

refreshButton.addEventListener("click", () => {
    loadArticles(true);
});

sortButtons.forEach(button => {
    button.addEventListener("click", event => {
        const sort = event.currentTarget.dataset.sort;
        if (sort === state.sort) {
            return;
        }
        state.sort = sort;
        sortButtons.forEach(btn => {
            const isActive = btn.dataset.sort === sort;
            btn.classList.toggle("is-active", isActive);
            btn.setAttribute("aria-pressed", String(isActive));
        });
        render();
    });
});

addFeedButton.addEventListener("click", () => {
    toggleAddFeedForm(true);
});

cancelAddFeed.addEventListener("click", () => {
    toggleAddFeedForm(false);
});

addFeedForm.addEventListener("submit", event => {
    event.preventDefault();
    const value = feedInput.value.trim();
    feedInput.setCustomValidity("");

    if (!isValidUrl(value)) {
        feedInput.setCustomValidity("Enter a valid HTTP or HTTPS URL.");
        feedInput.reportValidity();
        feedInput.setCustomValidity("");
        return;
    }

    addSource(value);
});

feedInput.addEventListener("input", () => {
    feedInput.setCustomValidity("");
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        if (!addFeedForm.hidden) {
            toggleAddFeedForm(false);
        }
        if (!historyPopup.hasAttribute("hidden")) {
            closeHistoryPopup();
        }
    }
});

themeToggle.addEventListener("click", toggleTheme);

historyButton.addEventListener("click", () => {
    if (historyPopup.hasAttribute("hidden")) {
        openHistoryPopup();
    } else {
        closeHistoryPopup();
    }
});

historyCloseButton.addEventListener("click", closeHistoryPopup);

historyClearButton.addEventListener("click", () => {
    state.searchHistory = [];
    persistSearchHistory();
    renderHistoryPopup();
});

historyPopup.addEventListener("click", event => {
    if (event.target === historyPopup) {
        closeHistoryPopup();
    }
});

applyTheme(loadThemePreference());
updateSourcesList();
renderHistoryPopup();
loadArticles();

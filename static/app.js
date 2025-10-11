const API_ENDPOINT = "/api/articles";
const AUDIO_STATUS_ENDPOINT = "/api/audio/status";
const AUDIO_POLL_INTERVAL = 5000;

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
const audioPlayer = document.getElementById("panelAudioPlayer");
const audioPlayerShell = document.getElementById("panelAudioPlayerShell");

if (audioPlayerShell) {
    audioPlayerShell.dataset.state = "idle";
}
const audioPlayerTitle = document.getElementById("panelAudioPlayerTitle");
const audioPlayerStatus = document.getElementById("panelAudioPlayerStatus");
const audioProgress = document.getElementById("audioProgressControl");
const audioProgressCurrent = document.getElementById("audioProgressCurrent");
const audioProgressDuration = document.getElementById("audioProgressDuration");
const audioToggleControl = document.getElementById("audioToggleControl");
const audioStopControl = document.getElementById("audioStopControl");
const audioCloseControl = document.getElementById("audioCloseControl");
const audioSkipLeftControl = document.getElementById("audioSkipLeftControl");
const audioSkipRightControl = document.getElementById("audioSkipRightControl");
const audioProgressVisualizer = document.getElementById("audioProgressVisualizer");
const audioProgressBars = audioProgressVisualizer
    ? Array.from(audioProgressVisualizer.querySelectorAll(".audio-progress-visualizer__line"))
    : [];
const audioPlayerDragHandle = audioPlayerShell?.querySelector(".audio-player__header");
const floatingHeading = document.createElement("div");
floatingHeading.id = "floatingHeading";
floatingHeading.className = "floating-heading";
floatingHeading.hidden = true;

if (audioProgressBars.length) {
    updateAudioVisualizerBars(0, false);
}
audioProgressVisualizer?.style.setProperty("--visualizer-progress", "0");

const audioPlayerDragState = {
    active: false,
    pointerId: null,
    offsetX: 0,
    offsetY: 0,
    width: 0,
    height: 0
};

const DRAG_MARGIN = 12;

if (audioPlayerDragHandle && audioPlayerShell) {
    audioPlayerDragHandle.addEventListener("pointerdown", handleAudioPlayerDragStart);
}

sourcesList.addEventListener("click", handleSourceFilterInteraction);
sourcesList.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") {
        return;
    }
    handleSourceFilterInteraction(event);
});

let sourceSequence = 0;
let cardObserver = null;
let panelProgressPanels = [];
let panelProgressRaf = null;
let panelProgressListenersAttached = false;
let isAudioScrubbing = false;
let audioProgressAnimationId = null;

const MAX_HISTORY = 15;
const PANEL_GROUP_SIZE = 6;
const PANEL_ACTIVE_RATIO = 0.12;
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
    searchHistory: loadSearchHistory(),
    activeSourceId: null,
    sourceCounts: new Map(),
    audioStatuses: new Map(),
    audioPollers: new Map(),
    currentAudioFeed: null,
    audioTitles: new Map()
};

if (audioPlayer) {
    audioPlayer.addEventListener("ended", handleGlobalAudioEnded);
    audioPlayer.addEventListener("pause", handleGlobalAudioPause);
    audioPlayer.addEventListener("play", handleGlobalAudioPlay);
    audioPlayer.addEventListener("timeupdate", updateAudioPlayerStatusText);
    audioPlayer.addEventListener("loadedmetadata", updateAudioPlayerStatusText);
}

if (audioToggleControl) {
    audioToggleControl.addEventListener("click", handleAudioToggleControl);
}

if (audioStopControl) {
    audioStopControl.addEventListener("click", () => {
        stopAudioPlayback();
    });
}

if (audioCloseControl) {
    audioCloseControl.addEventListener("click", () => {
        stopAudioPlayback();
    });
}

if (audioSkipLeftControl) {
    audioSkipLeftControl.addEventListener("click", () => {
        skipToPreviousAudio();
    });
}

if (audioSkipRightControl) {
    audioSkipRightControl.addEventListener("click", () => {
        skipToNextAudio();
    });
}

// Add keyboard support for audio skipping
document.addEventListener("keydown", (event) => {
    // Only handle keyboard shortcuts when audio player is visible and not typing in inputs
    if (audioPlayerShell && !audioPlayerShell.hidden && 
        !event.target.matches('input, textarea, [contenteditable]')) {
        
        if (event.key === "ArrowLeft" && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            skipToPreviousAudio();
        } else if (event.key === "ArrowRight" && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            skipToNextAudio();
        }
    }
});

if (audioProgress) {
    audioProgress.style.setProperty("--progress-ratio", "0");
    const endScrub = event => {
        if (!isAudioScrubbing) {
            return;
        }
        isAudioScrubbing = false;
        if (event && event.type.startsWith("pointer") && event.pointerId !== undefined && audioProgress.releasePointerCapture) {
            try {
                audioProgress.releasePointerCapture(event.pointerId);
            } catch {
                /* ignore pointer capture errors */
            }
        }
        updateAudioProgressUI();
    };
    audioProgress.addEventListener("pointerdown", event => {
        isAudioScrubbing = true;
        if (event.pointerId !== undefined && audioProgress.setPointerCapture) {
            try {
                audioProgress.setPointerCapture(event.pointerId);
            } catch {
                /* ignore pointer capture errors */
            }
        }
    });
    audioProgress.addEventListener("pointerup", endScrub);
    audioProgress.addEventListener("pointercancel", endScrub);
    audioProgress.addEventListener("blur", endScrub);
    audioProgress.addEventListener("keydown", () => {
        isAudioScrubbing = true;
    });
    audioProgress.addEventListener("keyup", endScrub);
    audioProgress.addEventListener("change", endScrub);
    audioProgress.addEventListener("input", handleAudioProgressInput);
}

syncAudioPlayerVisualState();

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
                const { items, title, url, feed, audio } = result.value;
                source.title = title;
                source.url = url;
                const feedKey = feed || url || source.feed;
                rememberAudioTitle(feedKey, title);
                if (audio) {
                    upsertAudioStatus(feedKey, audio);
                } else {
                    requestAudioStatus(feedKey);
                }
                scheduleAudioPolling(feedKey);
                items.forEach(item => {
                    aggregated.push({
                        ...item,
                        sourceId: source.id,
                        sourceTitle: title,
                        sourceUrl: url,
                        sourceFeed: feedKey
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
    const audio = payload.audio && typeof payload.audio === "object" ? payload.audio : null;
    if (audio && !audio.feed) {
        audio.feed = source.feed;
    }
    return { items, title, url: sourceUrl, feed: source.feed, audio };
}

function upsertAudioStatus(feedUrl, rawStatus) {
    if (!feedUrl) {
        return;
    }
    const status = normaliseAudioStatus(feedUrl, rawStatus);
    if (!status) {
        return;
    }
    state.audioStatuses.set(feedUrl, status);
    if (state.currentAudioFeed === feedUrl) {
        refreshRenderedAudioButtons();
        updateAudioPlayerStatusText();
    } else {
        refreshRenderedAudioButtons();
    }
}

function rememberAudioTitle(feedUrl, title) {
    if (!feedUrl || !title) {
        return;
    }
    state.audioTitles.set(feedUrl, title);
    if (state.currentAudioFeed === feedUrl && audioPlayerTitle) {
        audioPlayerTitle.textContent = title;
    }
}

function normaliseAudioStatus(feedUrl, rawStatus) {
    if (!rawStatus || typeof rawStatus !== "object") {
        return null;
    }
    const status = {
        feed: rawStatus.feed || feedUrl,
        status: rawStatus.status || "pending",
        audio_url: rawStatus.audio_url || null,
        mime_type: rawStatus.mime_type || null,
        transcript: rawStatus.transcript || null,
        error: rawStatus.error || null,
        updated_at: rawStatus.updated_at || null
    };
    return status;
}

function getAudioTitle(feedUrl) {
    if (!feedUrl) {
        return "";
    }
    if (state.audioTitles.has(feedUrl)) {
        return state.audioTitles.get(feedUrl);
    }
    const source = state.sources.find(entry => entry.feed === feedUrl || entry.url === feedUrl);
    if (source && source.title) {
        return source.title;
    }
    return deriveTitle("", feedUrl);
}

async function requestAudioStatus(feedUrl) {
    if (!feedUrl) {
        return;
    }
    try {
        const response = await fetch(`${AUDIO_STATUS_ENDPOINT}?feed=${encodeURIComponent(feedUrl)}`);
        if (!response.ok) {
            throw new Error(`Status request failed with ${response.status}`);
        }
        const payload = await response.json();
        upsertAudioStatus(feedUrl, payload);
        scheduleAudioPolling(feedUrl);
    } catch (error) {
        console.warn("Unable to refresh audio status:", error);
    }
}

function scheduleAudioPolling(feedUrl) {
    if (!feedUrl) {
        return;
    }
    const status = state.audioStatuses.get(feedUrl);
    if (!shouldPollStatus(status)) {
        clearAudioPoll(feedUrl);
        return;
    }
    if (state.audioPollers.has(feedUrl)) {
        return;
    }
    const timerId = window.setTimeout(() => {
        state.audioPollers.delete(feedUrl);
        requestAudioStatus(feedUrl);
    }, AUDIO_POLL_INTERVAL);
    state.audioPollers.set(feedUrl, timerId);
}

function clearAudioPoll(feedUrl) {
    const timerId = state.audioPollers.get(feedUrl);
    if (typeof timerId === "number") {
        window.clearTimeout(timerId);
    }
    state.audioPollers.delete(feedUrl);
}

function clearAllAudioPolling() {
    state.audioPollers.forEach(timerId => {
        if (typeof timerId === "number") {
            window.clearTimeout(timerId);
        }
    });
    state.audioPollers.clear();
}

function shouldPollStatus(status) {
    if (!status) {
        return true;
    }
    return status.status === "pending" || status.status === "generating";
}

function refreshRenderedAudioButtons() {
    const buttons = document.querySelectorAll(".panel__audio-button");
    buttons.forEach(button => {
        updateAudioButtonElement(button);
    });
    updateSkipButtonStates();
}

function updateAudioButtonElement(button) {
    if (!button) {
        return;
    }
    const feedUrl = button.dataset.feedUrl;
    if (feedUrl && !button.dataset.feedTitle) {
        button.dataset.feedTitle = getAudioTitle(feedUrl);
    }
    const status = feedUrl ? state.audioStatuses.get(feedUrl) : null;
    button.disabled = true;
    button.classList.remove("is-ready", "is-error", "is-playing");
    if (!status) {
        button.textContent = "Generating…";
        scheduleAudioPolling(feedUrl);
        return;
    }
    const labelStatus = status.status || "pending";
    if (labelStatus === "ready" && status.audio_url) {
        button.disabled = false;
        button.classList.add("is-ready");
        const isPlayingCurrent = state.currentAudioFeed === feedUrl && audioPlayer && !audioPlayer.paused;
        if (isPlayingCurrent) {
            button.classList.add("is-playing");
            button.textContent = "Pause audio";
        } else {
            button.textContent = "Play audio";
        }
        return;
    }
    if (labelStatus === "error" || labelStatus === "cancelled") {
        button.disabled = false;
        button.classList.add("is-error");
        button.textContent = "Retry audio";
        return;
    }
    if (labelStatus === "generating" || labelStatus === "pending" || labelStatus === "queued" || labelStatus === "missing") {
        button.textContent = "Generating…";
        return;
    }
    button.textContent = "Check audio";
}

function escapeAttributeSelector(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
}

function getPanelAudioButtons(feedUrl) {
    if (!feedUrl) {
        return [];
    }
    const selectorValue = escapeAttributeSelector(feedUrl);
    return Array.from(document.querySelectorAll(`.panel__audio-button[data-feed-url="${selectorValue}"]`));
}

function setPanelAudioButtonsVisibility(feedUrl, isVisible) {
    if (!feedUrl) {
        return;
    }
    getPanelAudioButtons(feedUrl).forEach(button => {
        button.hidden = !isVisible;
    });
}

function revealAllPanelAudioButtons() {
    document.querySelectorAll(".panel__audio-button[hidden]").forEach(button => {
        button.hidden = false;
    });
}

async function handlePanelAudioClick(event) {
    const button = event.currentTarget;
    const feedUrl = button?.dataset?.feedUrl;
    if (!feedUrl) {
        return;
    }
    const feedTitle = button?.dataset?.feedTitle || getAudioTitle(feedUrl);
    const status = state.audioStatuses.get(feedUrl);
    if (
        !status ||
        !status.status ||
        status.status === "pending" ||
        status.status === "generating" ||
        status.status === "missing" ||
        status.status === "queued"
    ) {
        button.disabled = true;
        requestAudioStatus(feedUrl);
        return;
    }
    if (status.status === "error") {
        button.disabled = true;
        await requestAudioStatus(feedUrl);
        button.disabled = false;
        return;
    }
    if (status.status === "ready" && status.audio_url) {
        if (state.currentAudioFeed === feedUrl && audioPlayer && !audioPlayer.paused) {
            audioPlayer.pause();
            return;
        }
        playPanelAudio(feedUrl, status, feedTitle);
        return;
    }
    requestAudioStatus(feedUrl);
}

function playPanelAudio(feedUrl, status, titleLabel) {
    if (!audioPlayer || !status.audio_url) {
        return;
    }
    if (feedUrl) {
        rememberAudioTitle(feedUrl, titleLabel || getAudioTitle(feedUrl));
    }
    const audioSrc = resolveAudioSourceUrl(status);
    if (audioPlayer.src !== audioSrc) {
        audioPlayer.src = audioSrc;
    }
    audioPlayer.dataset.feedUrl = feedUrl;
    if (titleLabel) {
        audioPlayer.dataset.feedTitle = titleLabel;
    }
    setPanelAudioButtonsVisibility(feedUrl, false);
    openAudioPlayerShell(feedUrl, titleLabel);
    updateAudioToggleControl(false, true);
    audioPlayer
        .play()
        .then(() => {
            setCurrentAudioFeed(feedUrl);
            updateAudioPlayerStatusText();
            startAudioProgressAnimation();
        })
        .catch(error => {
            console.warn("Unable to start audio playback:", error);
            setPanelAudioButtonsVisibility(feedUrl, true);
            updateAudioToggleControl(false, Boolean(audioPlayer.currentSrc));
        });
}

function resolveAudioSourceUrl(status) {
    if (!status.audio_url) {
        return "";
    }
    const cacheBust = status.updated_at ? `?v=${status.updated_at}` : "";
    return `${status.audio_url}${cacheBust}`;
}

function updateAudioToggleControl(isPlaying, hasSource) {
    if (audioToggleControl) {
        audioToggleControl.textContent = isPlaying ? "Pause" : "Play";
        audioToggleControl.dataset.state = isPlaying ? "pause" : "play";
        audioToggleControl.disabled = !hasSource;
    }
    syncAudioPlayerVisualState();
}

function syncAudioPlayerVisualState() {
    if (!audioPlayerShell) {
        return;
    }
    const hasSource = Boolean(audioPlayer?.currentSrc);
    const isPlaying = Boolean(audioPlayer && !audioPlayer.paused && !audioPlayer.ended);
    const isVisible = !audioPlayerShell.hidden;
    const shouldAnimate = isVisible && (hasSource || isPlaying);

    audioPlayerShell.classList.toggle("audio-player--active", shouldAnimate);
    audioPlayerShell.classList.toggle("audio-player--playing", isVisible && isPlaying);

    const visualState = isPlaying ? "playing" : hasSource ? "ready" : "idle";
    audioPlayerShell.dataset.state = visualState;
}

function startAudioProgressAnimation() {
    if (audioProgressAnimationId || !audioPlayer || !audioProgress || audioPlayer.paused || audioPlayer.ended) {
        updateAudioProgressUI();
        return;
    }
    const tick = () => {
        if (!audioPlayer || audioPlayer.paused || audioPlayer.ended) {
            audioProgressAnimationId = null;
            updateAudioProgressUI();
            return;
        }
        if (!isAudioScrubbing) {
            updateAudioProgressUI();
        }
        audioProgressAnimationId = requestAnimationFrame(tick);
    };
    audioProgressAnimationId = requestAnimationFrame(tick);
}

function stopAudioProgressAnimation() {
    if (audioProgressAnimationId) {
        cancelAnimationFrame(audioProgressAnimationId);
        audioProgressAnimationId = null;
    }
    updateAudioProgressUI();
}

function handleAudioProgressInput(event) {
    if (!audioPlayer || !audioProgress) {
        return;
    }
    const duration = audioPlayer.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
        return;
    }
    const rawValue = Number(event.target.value);
    if (!Number.isFinite(rawValue)) {
        return;
    }
    const clamped = Math.max(0, Math.min(rawValue, duration));
    audioPlayer.currentTime = clamped;
    updateAudioProgressUI(clamped, duration);
    if (audioPlayer.paused) {
        updateAudioPlayerStatusText();
    }
}

function updateAudioProgressUI(currentOverride, durationOverride) {
    if (!audioProgress) {
        return;
    }
    const resolvedDuration = Number.isFinite(durationOverride) && durationOverride > 0 ? durationOverride : audioPlayer?.duration;
    const hasDuration = Number.isFinite(resolvedDuration) && resolvedDuration > 0;
    const fallbackCurrent = Number.isFinite(currentOverride) ? currentOverride : audioPlayer?.currentTime || 0;
    const activeCurrent =
        isAudioScrubbing && !Number.isFinite(currentOverride) ? Number(audioProgress.value) || fallbackCurrent : fallbackCurrent;

    if (hasDuration) {
        const clampedCurrent = Math.max(0, Math.min(activeCurrent, resolvedDuration));
        if (!isAudioScrubbing || Number.isFinite(currentOverride)) {
            audioProgress.value = clampedCurrent;
        }
        audioProgress.disabled = false;
        audioProgress.max = resolvedDuration;
        const ratio = resolvedDuration ? Math.max(0, Math.min(1, Number(audioProgress.value) / resolvedDuration)) : 0;
        audioProgress.style.setProperty("--progress-ratio", ratio.toFixed(5));
        setAudioVisualizerRatio(ratio, true);
        if (audioProgressCurrent) {
            audioProgressCurrent.textContent = formatClockTime(clampedCurrent);
        }
        if (audioProgressDuration) {
            audioProgressDuration.textContent = formatClockTime(resolvedDuration);
        }
    } else {
        audioProgress.disabled = true;
        audioProgress.max = 1;
        if (!isAudioScrubbing || Number.isFinite(currentOverride)) {
            audioProgress.value = 0;
        }
        audioProgress.style.setProperty("--progress-ratio", "0");
        setAudioVisualizerRatio(0, false);
        if (audioProgressCurrent) {
            audioProgressCurrent.textContent = "00:00";
        }
        if (audioProgressDuration) {
            audioProgressDuration.textContent = "--:--";
        }
    }
}

function setAudioVisualizerRatio(ratio, hasDuration = true) {
    if (!audioProgressVisualizer) {
        return;
    }
    const isPlaying = Boolean(audioPlayer && !audioPlayer.paused && !audioPlayer.ended);
    let nextRatio = Number.isFinite(ratio) ? ratio : 0;
    nextRatio = Math.max(0, Math.min(nextRatio, 1));
    let appliedRatio = nextRatio;
    if (isPlaying && audioProgressBars.length) {
        const minimumVisible = 1 / audioProgressBars.length;
        appliedRatio = Math.max(appliedRatio, minimumVisible);
    }
    audioProgressVisualizer?.style.setProperty("--visualizer-progress", appliedRatio.toFixed(5));
    updateAudioVisualizerBars(appliedRatio, isPlaying);
}

function updateAudioVisualizerBars(ratio, isPlaying) {
    if (!audioProgressBars.length) {
        return;
    }
    const normalizedRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
    const totalBars = audioProgressBars.length;
    let activeCount = Math.ceil(normalizedRatio * totalBars);

    if (normalizedRatio <= 0) {
        activeCount = isPlaying ? 1 : 0;
    } else {
        activeCount = Math.max(activeCount, 1);
        if (isPlaying) {
            const easedCount = Math.max(1, Math.ceil(normalizedRatio * totalBars));
            activeCount = Math.max(activeCount, easedCount);
        }
    }
    activeCount = Math.min(totalBars, activeCount);

    audioProgressBars.forEach((bar, index) => {
        const shouldActivate = index < activeCount;
        bar.classList.toggle("is-active", shouldActivate);
    });
}

function handleAudioToggleControl() {
    if (!audioPlayer) {
        return;
    }
    const hasSource = Boolean(audioPlayer.currentSrc);
    if (!hasSource) {
        const fallbackFeed = audioPlayer.dataset.feedUrl || state.currentAudioFeed;
        if (fallbackFeed) {
            const status = state.audioStatuses.get(fallbackFeed);
            if (status && status.audio_url) {
                playPanelAudio(fallbackFeed, status, getAudioTitle(fallbackFeed));
            }
        }
        return;
    }
    if (audioPlayer.paused || audioPlayer.ended) {
        audioPlayer
            .play()
            .then(() => {
                updateAudioPlayerStatusText();
            })
            .catch(error => {
                console.warn("Unable to resume playback:", error);
            });
    } else {
        audioPlayer.pause();
    }
}

function openAudioPlayerShell(feedUrl, titleLabel) {
    if (!audioPlayerShell) {
        return;
    }
    if (feedUrl) {
        audioPlayerShell.dataset.feedUrl = feedUrl;
    }
    if (titleLabel && audioPlayerTitle) {
        audioPlayerTitle.textContent = titleLabel;
    } else if (audioPlayerTitle && feedUrl) {
        audioPlayerTitle.textContent = getAudioTitle(feedUrl);
    }
    audioPlayerShell.hidden = false;
    body?.classList.add("has-active-audio-player");
    updateAudioPlayerStatusText();
    updateAudioToggleControl(!audioPlayer?.paused && !audioPlayer?.ended, Boolean(audioPlayer?.src));
}

function hideAudioPlayerShell() {
    if (!audioPlayerShell) {
        return;
    }
    audioPlayerShell.hidden = true;
    audioPlayerShell.dataset.feedUrl = "";
    audioPlayerShell.classList.remove("audio-player--active", "audio-player--playing");
    body?.classList.remove("has-active-audio-player");
    setAudioVisualizerRatio(0, false);
    audioPlayerShell.style.removeProperty("left");
    audioPlayerShell.style.removeProperty("top");
    audioPlayerShell.style.removeProperty("right");
    audioPlayerShell.style.removeProperty("bottom");
    syncAudioPlayerVisualState();
}

function updateAudioPlayerStatusText() {
    if (!audioPlayerStatus || !audioPlayer) {
        return;
    }
    const currentSeconds = audioPlayer.currentTime || 0;
    const durationSeconds = audioPlayer.duration;
    updateAudioProgressUI(currentSeconds, durationSeconds);

    const isPlaying = !audioPlayer.paused && !audioPlayer.ended;
    const statusLabel = audioPlayer.ended
        ? "Finished"
        : isPlaying
            ? "Playing"
            : currentSeconds > 0
                ? "Paused"
                : "Ready";
    audioPlayerStatus.textContent = statusLabel;
    updateAudioToggleControl(isPlaying, Boolean(audioPlayer.currentSrc));
}

function formatClockTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "00:00";
    }
    const totalSeconds = Math.floor(seconds);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function stopAudioPlayback() {
    if (!audioPlayer) {
        return;
    }
    isAudioScrubbing = false;
    stopAudioProgressAnimation();
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    audioPlayer.removeAttribute("src");
    audioPlayer.dataset.feedUrl = "";
    audioPlayer.dataset.feedTitle = "";
    audioPlayer.load();
    updateAudioPlayerStatusText();
    updateAudioToggleControl(false, false);
    setCurrentAudioFeed(null);
    hideAudioPlayerShell();
    syncAudioPlayerVisualState();
}

function handleGlobalAudioEnded() {
    if (!audioPlayer) {
        return;
    }
    stopAudioProgressAnimation();
    updateAudioPlayerStatusText();
    updateAudioToggleControl(false, Boolean(audioPlayer.currentSrc));
    const feedUrl = audioPlayer.dataset.feedUrl || null;
    if (feedUrl) {
        rememberAudioTitle(feedUrl, audioPlayer.dataset.feedTitle || getAudioTitle(feedUrl));
        setCurrentAudioFeed(feedUrl);
    }
    syncAudioPlayerVisualState();
}

function handleGlobalAudioPause() {
    if (!audioPlayer) {
        return;
    }
    stopAudioProgressAnimation();
    updateAudioPlayerStatusText();
    if (audioPlayer.ended) {
        const feedUrl = audioPlayer.dataset.feedUrl || null;
        if (feedUrl) {
            rememberAudioTitle(feedUrl, audioPlayer.dataset.feedTitle || getAudioTitle(feedUrl));
            setCurrentAudioFeed(feedUrl);
        }
        syncAudioPlayerVisualState();
        return;
    }
    if (audioPlayer.currentTime === 0 && !audioPlayer.currentSrc) {
        hideAudioPlayerShell();
        setCurrentAudioFeed(null);
    } else {
        const feedUrl = audioPlayer.dataset.feedUrl || null;
        if (feedUrl) {
            rememberAudioTitle(feedUrl, audioPlayer.dataset.feedTitle || getAudioTitle(feedUrl));
            setCurrentAudioFeed(feedUrl);
        }
    }
    syncAudioPlayerVisualState();
}

function handleGlobalAudioPlay() {
    if (!audioPlayer) {
        return;
    }
    const feedUrl = audioPlayer.dataset.feedUrl || null;
    const title = audioPlayer.dataset.feedTitle || getAudioTitle(feedUrl);
    if (feedUrl) {
        rememberAudioTitle(feedUrl, title);
        openAudioPlayerShell(feedUrl, title);
    }
    setCurrentAudioFeed(feedUrl);
    startAudioProgressAnimation();
    syncAudioPlayerVisualState();
}

function setCurrentAudioFeed(feedUrl) {
    const previousFeed = state.currentAudioFeed;
    if (previousFeed === feedUrl) {
        refreshRenderedAudioButtons();
        updateAudioPlayerStatusText();
        return;
    }
    state.currentAudioFeed = feedUrl;

    // Remove active class from previous panel
    if (previousFeed) {
        const previousPanel = document.querySelector(`.panel[data-feed-url="${escapeAttributeSelector(previousFeed)}"]`);
        if (previousPanel) {
            previousPanel.classList.remove('panel--audio-active');
        }
        setPanelAudioButtonsVisibility(previousFeed, true);
    }

    if (feedUrl) {
        // Add active class to current panel
        const currentPanel = document.querySelector(`.panel[data-feed-url="${escapeAttributeSelector(feedUrl)}"]`);
        if (currentPanel) {
            currentPanel.classList.add('panel--audio-active');
        }
        setPanelAudioButtonsVisibility(feedUrl, false);
        openAudioPlayerShell(feedUrl, getAudioTitle(feedUrl));
    } else {
        // Remove active class from all panels
        document.querySelectorAll('.panel--audio-active').forEach(panel => {
            panel.classList.remove('panel--audio-active');
        });
        revealAllPanelAudioButtons();
        hideAudioPlayerShell();
    }
    refreshRenderedAudioButtons();
    updateSkipButtonStates();
}

function getAvailableAudioFeeds() {
    const availableFeeds = [];
    
    // Get all panels in the order they appear on screen
    const panels = Array.from(document.querySelectorAll('.panel[data-feed-url]'));
    
    panels.forEach(panel => {
        const feedUrl = panel.dataset.feedUrl;
        if (feedUrl) {
            const status = state.audioStatuses.get(feedUrl);
            // Only include feeds that have ready audio
            if (status && status.status === 'ready' && status.audio_url) {
                availableFeeds.push({
                    feedUrl,
                    title: getAudioTitle(feedUrl),
                    panel
                });
            }
        }
    });
    
    return availableFeeds;
}

function getCurrentAudioIndex() {
    const availableFeeds = getAvailableAudioFeeds();
    const currentFeed = state.currentAudioFeed;
    
    if (!currentFeed) {
        return -1;
    }
    
    return availableFeeds.findIndex(feed => feed.feedUrl === currentFeed);
}

function skipToPreviousAudio() {
    const availableFeeds = getAvailableAudioFeeds();
    
    if (availableFeeds.length <= 1) {
        return; // No other audio to skip to
    }
    
    const currentIndex = getCurrentAudioIndex();
    let previousIndex;
    
    if (currentIndex <= 0) {
        // If at the beginning or no current audio, go to the last one
        previousIndex = availableFeeds.length - 1;
    } else {
        previousIndex = currentIndex - 1;
    }
    
    const previousFeed = availableFeeds[previousIndex];
    if (previousFeed) {
        const status = state.audioStatuses.get(previousFeed.feedUrl);
        if (status && status.audio_url) {
            playPanelAudio(previousFeed.feedUrl, status, previousFeed.title);
        }
    }
}

function skipToNextAudio() {
    const availableFeeds = getAvailableAudioFeeds();
    
    if (availableFeeds.length <= 1) {
        return; // No other audio to skip to
    }
    
    const currentIndex = getCurrentAudioIndex();
    let nextIndex;
    
    if (currentIndex >= availableFeeds.length - 1 || currentIndex === -1) {
        // If at the end or no current audio, go to the first one
        nextIndex = 0;
    } else {
        nextIndex = currentIndex + 1;
    }
    
    const nextFeed = availableFeeds[nextIndex];
    if (nextFeed) {
        const status = state.audioStatuses.get(nextFeed.feedUrl);
        if (status && status.audio_url) {
            playPanelAudio(nextFeed.feedUrl, status, nextFeed.title);
        }
    }
}

function updateSkipButtonStates() {
    const availableFeeds = getAvailableAudioFeeds();
    const hasMultipleFeeds = availableFeeds.length > 1;
    const currentIndex = getCurrentAudioIndex();
    
    if (audioSkipLeftControl) {
        audioSkipLeftControl.disabled = !hasMultipleFeeds;
        
        if (hasMultipleFeeds && currentIndex >= 0) {
            const prevIndex = currentIndex <= 0 ? availableFeeds.length - 1 : currentIndex - 1;
            const prevFeed = availableFeeds[prevIndex];
            audioSkipLeftControl.setAttribute('aria-label', 
                `Skip to previous audio: ${prevFeed ? prevFeed.title : 'Previous'}`);
        } else {
            audioSkipLeftControl.setAttribute('aria-label', 'Skip to previous audio');
        }
    }
    
    if (audioSkipRightControl) {
        audioSkipRightControl.disabled = !hasMultipleFeeds;
        
        if (hasMultipleFeeds && currentIndex >= 0) {
            const nextIndex = currentIndex >= availableFeeds.length - 1 ? 0 : currentIndex + 1;
            const nextFeed = availableFeeds[nextIndex];
            audioSkipRightControl.setAttribute('aria-label', 
                `Skip to next audio: ${nextFeed ? nextFeed.title : 'Next'}`);
        } else {
            audioSkipRightControl.setAttribute('aria-label', 'Skip to next audio');
        }
    }
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
        clearAllAudioPolling();
        state.audioStatuses.clear();
        state.audioTitles.clear();
        if (audioPlayer && !audioPlayer.paused) {
            audioPlayer.pause();
        }
        setCurrentAudioFeed(null);
        refreshRenderedAudioButtons();
        return;
    }
    state.audioTitles.clear();

    const filtered = filterAndSort(state.items);
    const filteredBySource = state.activeSourceId
        ? filtered.filter(article => article.sourceId === state.activeSourceId)
        : filtered;

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
            refreshRenderedAudioButtons();
            return;
        }

        toggleError(false);
        emptyState.hidden = false;
        statusHeadline.textContent = state.query
            ? `No matches for “${state.query}”`
            : "No stories available.";
        refreshRenderedAudioButtons();
        return;
    }

    if (!filteredBySource.length) {
        if (cardObserver) {
            cardObserver.disconnect();
            cardObserver = null;
        }
        panelsContainer.innerHTML = "";
        toggleError(false);
        emptyState.hidden = false;
        const sourceLabel =
            formatSourceLabel(state.sources.find(source => source.id === state.activeSourceId) ?? {}) ||
            "selected source";
        statusHeadline.textContent = `No stories available for ${sourceLabel}.`;
        refreshRenderedAudioButtons();
        return;
    }

    toggleError(false);
    emptyState.hidden = true;
    if (cardObserver) {
        cardObserver.disconnect();
        cardObserver = null;
    }
    panelsContainer.innerHTML = "";

    const groups = groupArticlesBySource(filteredBySource);
    groups.forEach(group => {
        const panelElement = createPanel(group.articles, group);
        panelElement.classList.add("is-active");
        panelsContainer.appendChild(panelElement);
    });
    setupCardObserver();
    initializePanelProgressTracking();
    refreshRenderedAudioButtons();

    const descriptor = state.query ? "stories matching your search" : "stories";
    const activeSourceLabel = state.activeSourceId
        ? formatSourceLabel(state.sources.find(source => source.id === state.activeSourceId) ?? {})
        : null;
    let message = `Showing ${filteredBySource.length} ${descriptor}`;
    if (activeSourceLabel) {
        message += ` from ${activeSourceLabel}`;
    }
    if (state.sources.length > 1 && !state.activeSourceId) {
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
    const panelFeed = panelMeta.feed ?? panelMeta.url ?? "";
    const panelTitle = panelMeta.title || deriveTitle("", panelFeed);
    panel.dataset.feedUrl = panelFeed;
    panel.dataset.feedTitle = panelTitle;

    const header = document.createElement("div");
    header.className = "panel__header";
    const headerText = document.createElement("div");
    headerText.className = "panel__header-text";
    const eyebrow = document.createElement("span");
    eyebrow.className = "panel__eyebrow";
    eyebrow.textContent = "Feed focus";
    headerText.appendChild(eyebrow);
    const title = document.createElement("h3");
    title.className = "panel__title";
    title.textContent = panelTitle || "Loading feed";
    headerText.appendChild(title);
    header.appendChild(headerText);

    const headerActions = document.createElement("div");
    headerActions.className = "panel__header-actions";
    const audioButton = createPanelAudioButton(panel.dataset.feedUrl, panelTitle);
    if (audioButton) {
        headerActions.appendChild(audioButton);
    }
    header.appendChild(headerActions);
    panel.appendChild(header);

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

function createPanelAudioButton(feedUrl, label) {
    if (!feedUrl) {
        return null;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "panel__audio-button";
    button.dataset.feedUrl = feedUrl;
    if (label) {
        button.dataset.feedTitle = label;
    }
    button.addEventListener("click", handlePanelAudioClick);
    updateAudioButtonElement(button);
    return button;
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
                feed: article.sourceFeed || article.sourceUrl,
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
            threshold: [0, PANEL_ACTIVE_RATIO, 0.45, 0.85],
            rootMargin: "0px 0px -6% 0px"
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
        const scaleBase = 1 + (1 - progress) * 0.32;
        const finalScale = clamp(scaleBase * lengthScale, 0.6, 1.42);
        panel.style.setProperty("--panel-progress", progress.toFixed(3));
        panel.style.setProperty("--panel-grid-progress", gridProgress.toFixed(3));
        panel.style.setProperty("--panel-title-scale", finalScale.toFixed(3));
        panel.classList.toggle("panel--grid-ready", gridProgress > 0.08);
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

function handleAudioPlayerDragStart(event) {
    if (!audioPlayerShell) {
        return;
    }
    if (event.button !== undefined && event.button !== 0) {
        return;
    }
    if (event.target.closest(".audio-player__close")) {
        return;
    }
    const rect = audioPlayerShell.getBoundingClientRect();
    audioPlayerShell.style.right = "auto";
    audioPlayerShell.style.bottom = "auto";
    audioPlayerShell.style.left = `${rect.left}px`;
    audioPlayerShell.style.top = `${rect.top}px`;

    audioPlayerDragState.active = true;
    audioPlayerDragState.pointerId = event.pointerId;
    audioPlayerDragState.offsetX = event.clientX - rect.left;
    audioPlayerDragState.offsetY = event.clientY - rect.top;
    audioPlayerDragState.width = rect.width;
    audioPlayerDragState.height = rect.height;

    audioPlayerShell.classList.add("is-dragging");
    audioPlayerShell.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", handleAudioPlayerDragMove);
    window.addEventListener("pointerup", handleAudioPlayerDragEnd);
    window.addEventListener("pointercancel", handleAudioPlayerDragEnd);
    event.preventDefault();
}

function handleAudioPlayerDragMove(event) {
    if (!audioPlayerShell || !audioPlayerDragState.active || event.pointerId !== audioPlayerDragState.pointerId) {
        return;
    }
    const maxLeft = Math.max(DRAG_MARGIN, window.innerWidth - audioPlayerDragState.width - DRAG_MARGIN);
    const maxTop = Math.max(DRAG_MARGIN, window.innerHeight - audioPlayerDragState.height - DRAG_MARGIN);
    const nextLeft = clamp(event.clientX - audioPlayerDragState.offsetX, DRAG_MARGIN, maxLeft);
    const nextTop = clamp(event.clientY - audioPlayerDragState.offsetY, DRAG_MARGIN, maxTop);
    audioPlayerShell.style.left = `${nextLeft}px`;
    audioPlayerShell.style.top = `${nextTop}px`;
}

function handleAudioPlayerDragEnd(event) {
    if (!audioPlayerShell || !audioPlayerDragState.active || event.pointerId !== audioPlayerDragState.pointerId) {
        return;
    }
    audioPlayerDragState.active = false;
    audioPlayerShell.classList.remove("is-dragging");
    audioPlayerShell.releasePointerCapture?.(event.pointerId);
    window.removeEventListener("pointermove", handleAudioPlayerDragMove);
    window.removeEventListener("pointerup", handleAudioPlayerDragEnd);
    window.removeEventListener("pointercancel", handleAudioPlayerDragEnd);
    constrainAudioPlayerToViewport();
}

function constrainAudioPlayerToViewport() {
    if (!audioPlayerShell) {
        return;
    }
    const rect = audioPlayerShell.getBoundingClientRect();
    const maxLeft = Math.max(DRAG_MARGIN, window.innerWidth - rect.width - DRAG_MARGIN);
    const maxTop = Math.max(DRAG_MARGIN, window.innerHeight - rect.height - DRAG_MARGIN);
    const clampedLeft = clamp(rect.left, DRAG_MARGIN, maxLeft);
    const clampedTop = clamp(rect.top, DRAG_MARGIN, maxTop);
    audioPlayerShell.style.left = `${clampedLeft}px`;
    audioPlayerShell.style.top = `${clampedTop}px`;
}

window.addEventListener("resize", () => {
    if (!audioPlayerShell || audioPlayerShell.hidden || !audioPlayerShell.style.left) {
        return;
    }
    constrainAudioPlayerToViewport();
});

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
        const headerText = document.createElement("div");
        headerText.className = "panel__header-text";
        const eyebrow = document.createElement("span");
        eyebrow.className = "panel__eyebrow";
        eyebrow.textContent = "Feed focus";
        headerText.appendChild(eyebrow);
        const title = document.createElement("h3");
        title.className = "panel__title";
        title.textContent = "Loading feed";
        headerText.appendChild(title);
        header.appendChild(headerText);
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

function updateSourcesList(counts = state.sourceCounts) {
    if (!(counts instanceof Map)) {
        counts = new Map(counts ? Array.from(counts) : []);
    }
    state.sourceCounts = counts;
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
        pill.dataset.sourceId = source.id;
        pill.setAttribute("role", "button");
        pill.setAttribute("tabindex", "0");
        const isActive = state.activeSourceId === source.id;
        pill.classList.toggle("is-active", isActive);
        pill.setAttribute("aria-pressed", String(isActive));
        sourcesList.appendChild(pill);
    });
}

function handleSourceFilterInteraction(event) {
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
        return;
    }
    const pill = event.target.closest(".source-pill[data-source-id]");
    if (!pill) {
        return;
    }
    event.preventDefault();
    const selectedId = pill.dataset.sourceId;
    const nextActive = state.activeSourceId === selectedId ? null : selectedId;
    if (state.activeSourceId === nextActive) {
        return;
    }
    state.activeSourceId = nextActive;
    updateSourcesList(state.sourceCounts);
    render();
}

function toggleAddFeedForm(show) {
    if (show) {
        addFeedForm.hidden = false;
        addFeedForm.classList.remove("is-visible", "is-closing");
        // allow layout to settle before animating in
        requestAnimationFrame(() => {
            addFeedForm.classList.add("is-visible");
        });
        addFeedButton.hidden = true;
        feedInput.value = "";
        requestAnimationFrame(() => {
            feedInput.focus();
        });
        return;
    }

    if (addFeedForm.hidden) {
        addFeedButton.hidden = false;
        return;
    }

    addFeedForm.classList.remove("is-visible");
    addFeedForm.classList.add("is-closing");
    const handleTransitionEnd = event => {
        if (event.target !== addFeedForm) {
            return;
        }
        addFeedForm.hidden = true;
        addFeedForm.classList.remove("is-closing");
    };
    addFeedForm.addEventListener("transitionend", handleTransitionEnd, { once: true });
    addFeedButton.hidden = false;
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

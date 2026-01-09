// Tauri API
const { invoke } = window.__TAURI__.core;

// State
let sessions = [];
let allSessions = [];  // Unfiltered sessions
let currentSession = null;
let currentSessionData = null;
let searchTimeout = null;
let sortNewestFirst = true;
let showThinking = false;
let selectedProject = '';
let selectedMessageIndex = -1;
let watchInterval = null;

// Virtual scroll state
let allMessages = [];           // All messages (sorted)
let messageHeights = new Map(); // msg_id -> actual height
let messageOffsets = [];        // Cumulative offsets for each message
let totalHeight = 0;
let visibleRange = { start: 0, end: 20 };
const ESTIMATED_HEIGHT = 80;    // Default estimate per message (conservative)
const BUFFER_PX = 400;          // Render buffer above/below viewport
const GAP = 16;                 // Gap between messages

// DOM elements
const sessionList = document.getElementById('session-list');
const sessionCount = document.getElementById('session-count');
const projectFilter = document.getElementById('project-filter');
const content = document.getElementById('content');
const searchInput = document.getElementById('search-input');
const syncBtn = document.getElementById('sync-btn');
const sortBtn = document.getElementById('sort-btn');
const thinkingBtn = document.getElementById('thinking-btn');
const scrollTopBtn = document.getElementById('scroll-top-btn');
const shortcutsBtn = document.getElementById('shortcuts-btn');
const shortcutsModal = document.getElementById('shortcuts-modal');
const modalClose = document.getElementById('modal-close');
const statusText = document.getElementById('status-text');
const syncStatusEl = document.getElementById('sync-status');

// API calls via Tauri invoke
async function fetchSessions() {
    return await invoke('get_sessions', { limit: 1000 });
}

async function fetchProjects() {
    return await invoke('get_projects');
}

async function fetchMessages(sessionId) {
    return await invoke('get_messages', { sessionId });
}

async function searchMessages(query) {
    return await invoke('search', { query, limit: 50 });
}

async function triggerSync() {
    syncBtn.disabled = true;
    syncBtn.textContent = '↻ Syncing...';
    try {
        const stats = await invoke('trigger_sync');
        syncStatusEl.textContent = `Synced ${stats.synced} sessions`;
        await loadSessions();
    } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = '↻ Sync';
    }
}

// Watch for session updates
function startWatching(sessionId) {
    if (watchInterval) {
        clearInterval(watchInterval);
    }
    if (!sessionId) return;

    watchInterval = setInterval(async () => {
        try {
            const updated = await invoke('check_session_update', { sessionId });
            if (updated && currentSession && currentSession.session_id === sessionId) {
                await invoke('sync_session', { sessionId });
                const messages = await fetchMessages(sessionId);
                currentSessionData = { session: currentSession, messages };
                renderSession(currentSessionData);
            }
        } catch (e) {
            console.error('Watch error:', e);
        }
    }, 1500);
}

// Sort functions
function toggleSort() {
    sortNewestFirst = !sortNewestFirst;
    sortBtn.textContent = sortNewestFirst ? '↓ Newest first' : '↑ Oldest first';
    if (currentSessionData) {
        renderSession(currentSessionData);
    }
}

function toggleThinking() {
    showThinking = !showThinking;
    thinkingBtn.textContent = showThinking ? '◉ Thinking' : '○ Thinking';
    document.body.classList.toggle('show-thinking', showThinking);

    // Clear all cached heights since thinking blocks affect all messages
    messageHeights.clear();

    // Recalculate heights and re-render after CSS transition
    setTimeout(() => {
        // Re-measure visible message heights
        document.querySelectorAll('.message').forEach(msg => {
            const id = msg.id;
            const height = msg.offsetHeight;
            if (height > 0) {
                messageHeights.set(id, height);
            }
        });
        calculateOffsets();
        renderMinimap();
        updateMinimapViewport(content.scrollTop, content.clientHeight);
    }, 50);
}

// Render functions
function renderSessionList() {
    sessionCount.textContent = sessions.length;
    sessionList.innerHTML = sessions.map(s => `
        <li class="session-item ${currentSession?.session_id === s.session_id ? 'active' : ''}"
            data-id="${s.session_id}">
            <div class="session-project">${escapeHtml(s.project || '')}</div>
            <div class="session-title">${escapeHtml(s.first_message || 'No message')}</div>
            <div class="session-meta">
                <span class="agent-name ${s.agent || 'claude'}">${formatAgentName(s.agent)}</span>
                <span class="meta-sep">·</span>
                <span>${s.message_count} msgs</span>
                <span class="meta-sep">·</span>
                <span>${formatDate(s.started_at)}</span>
            </div>
        </li>
    `).join('');

    sessionList.querySelectorAll('.session-item').forEach(item => {
        item.addEventListener('click', () => loadSession(item.dataset.id));
    });

    // Scroll active session into view
    const activeItem = sessionList.querySelector('.session-item.active');
    if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

// Calculate message offsets based on known or estimated heights
function calculateOffsets() {
    messageOffsets = [];
    if (allMessages.length === 0) {
        totalHeight = 0;
        return 0;
    }
    let offset = 0;
    for (let i = 0; i < allMessages.length; i++) {
        messageOffsets.push(offset);
        const height = messageHeights.get(allMessages[i].msg_id) || ESTIMATED_HEIGHT;
        offset += height + GAP;
    }
    totalHeight = Math.max(0, offset - GAP); // Remove last gap, ensure non-negative
    return totalHeight;
}

// Update container height after offset recalculation
function updateContainerHeight() {
    const messagesContainer = document.querySelector('.messages');
    if (messagesContainer) {
        messagesContainer.style.minHeight = `${totalHeight}px`;
    }
}

// Find which messages are visible given scroll position
function getVisibleRange(scrollTop, containerHeight) {
    if (allMessages.length === 0) return { start: 0, end: 0 };

    const viewStart = Math.max(0, scrollTop - BUFFER_PX);
    const viewEnd = scrollTop + containerHeight + BUFFER_PX;

    let start = 0;
    let end = allMessages.length;

    // Binary search for start
    let lo = 0, hi = allMessages.length - 1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const msgBottom = messageOffsets[mid] + (messageHeights.get(allMessages[mid].msg_id) || ESTIMATED_HEIGHT);
        if (msgBottom < viewStart) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    start = Math.max(0, lo - 1);

    // Binary search for end
    lo = start;
    hi = allMessages.length - 1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (messageOffsets[mid] > viewEnd) {
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }
    end = Math.min(allMessages.length, hi + 2);

    return { start, end };
}

// Debounced height recalculation
let heightRecalcTimeout = null;
let lastMinimapHeight = 0;
let lastMeasuredCount = 0;
let minimapClickInProgress = false;
let minimapClickTimeout = null;
let minimapNeedsRender = false;
function scheduleHeightRecalc() {
    if (heightRecalcTimeout) return;
    heightRecalcTimeout = setTimeout(() => {
        heightRecalcTimeout = null;
        calculateOffsets();
        updateContainerHeight();

        // Check if minimap needs re-render
        const measuredCount = messageHeights.size;
        const heightChanged = Math.abs(totalHeight - lastMinimapHeight) > lastMinimapHeight * 0.05;
        const manyNewMeasured = measuredCount - lastMeasuredCount > 10;
        const shouldRenderMinimap = heightChanged || manyNewMeasured;

        // Skip minimap re-render if triggered by minimap click (prevents judder)
        if (minimapClickInProgress) {
            if (shouldRenderMinimap) {
                minimapNeedsRender = true;  // Defer until click completes
            }
            updateMinimapViewport(content.scrollTop, content.clientHeight);
            return;
        }

        if (shouldRenderMinimap) {
            lastMinimapHeight = totalHeight;
            lastMeasuredCount = measuredCount;
            renderMinimap();
        }
        updateMinimapViewport(content.scrollTop, content.clientHeight);
    }, 100);
}

// Render only visible messages
function renderVisibleMessages() {
    const messagesContainer = document.querySelector('.messages');
    if (!messagesContainer) return;

    let { start, end } = visibleRange;

    // Ensure valid bounds
    start = Math.max(0, Math.min(start, allMessages.length));
    end = Math.max(start, Math.min(end, allMessages.length));

    // If no messages to render, show empty
    if (start >= end || allMessages.length === 0) {
        messagesContainer.innerHTML = '';
        return;
    }

    // Calculate spacers based on offsets
    const topSpacer = start > 0 && messageOffsets[start] !== undefined ? messageOffsets[start] : 0;

    // Bottom spacer: total height minus the end of the last rendered message
    let bottomSpacer = 0;
    if (end < allMessages.length && end > 0) {
        const lastRenderedIdx = end - 1;
        const lastOffset = messageOffsets[lastRenderedIdx] || 0;
        const lastHeight = messageHeights.get(allMessages[lastRenderedIdx]?.msg_id) || ESTIMATED_HEIGHT;
        bottomSpacer = totalHeight - lastOffset - lastHeight - GAP;
    }
    bottomSpacer = Math.max(0, bottomSpacer);

    let html = `<div class="message-spacer" style="height: ${topSpacer}px;"></div>`;

    for (let i = start; i < end; i++) {
        const m = allMessages[i];
        const roleClass = m.role === 'assistant' ? 'agent' : m.role;
        const roleLabel = m.role === 'assistant' ? 'agent' : m.role;
        html += `
            <div class="message ${roleClass} ${i === selectedMessageIndex ? 'selected' : ''}"
                 id="${m.msg_id}" data-index="${i}">
                <div class="message-header">
                    <span class="message-role">${roleLabel}</span>
                    <span class="message-time">${formatTime(m.timestamp)}</span>
                </div>
                <div class="message-content">${formatContent(m.content)}</div>
            </div>
        `;
    }

    html += `<div class="message-spacer" style="height: ${bottomSpacer}px;"></div>`;

    messagesContainer.innerHTML = html;

    // Measure rendered messages and update heights
    let heightsChanged = false;
    messagesContainer.querySelectorAll('.message').forEach(msg => {
        const id = msg.id;
        const height = msg.offsetHeight;
        if (height > 0 && messageHeights.get(id) !== height) {
            messageHeights.set(id, height);
            heightsChanged = true;
        }
        msg.addEventListener('click', () => {
            selectMessage(parseInt(msg.dataset.index));
        });
    });

    // Schedule recalculation if heights changed
    if (heightsChanged) {
        scheduleHeightRecalc();
    }
}

// Throttled scroll handler
let scrollRaf = null;
function handleScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        const scrollTop = content.scrollTop;
        const containerHeight = content.clientHeight;
        const newRange = getVisibleRange(scrollTop, containerHeight);

        if (newRange.start !== visibleRange.start || newRange.end !== visibleRange.end) {
            visibleRange = newRange;
            renderVisibleMessages();
        }

        updateMinimapViewport(scrollTop, containerHeight);
    });
}

// Render minimap
function renderMinimap() {
    const minimap = document.querySelector('.minimap');
    if (!minimap || allMessages.length === 0) return;

    // Ensure offsets are calculated for all messages
    if (messageOffsets.length !== allMessages.length) {
        calculateOffsets();
    }

    const canvas = minimap.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Set canvas size
    const canvasWidth = 80;
    const canvasHeight = minimap.clientHeight;
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    ctx.scale(dpr, dpr);

    const scale = canvasHeight / Math.max(totalHeight, 1);

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Draw messages
    for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i];
        const offset = messageOffsets[i] ?? (i * (ESTIMATED_HEIGHT + GAP));
        const height = messageHeights.get(m.msg_id) || ESTIMATED_HEIGHT;
        const y = offset * scale;
        const h = Math.max(2, height * scale);

        ctx.fillStyle = m.role === 'user' ? '#58a6ff' : '#9d7cd8';
        ctx.fillRect(8, y, 64, h - 1);
    }
}

// Update minimap viewport indicator
function updateMinimapViewport(scrollTop, containerHeight) {
    const viewport = document.querySelector('.minimap-viewport');
    if (!viewport || totalHeight === 0) return;

    const minimap = document.querySelector('.minimap');
    const canvasHeight = minimap.clientHeight;
    const scale = canvasHeight / Math.max(totalHeight, 1);

    const top = scrollTop * scale;
    const height = containerHeight * scale;

    viewport.style.top = `${top}px`;
    viewport.style.height = `${height}px`;
}

// Handle minimap click
function handleMinimapClick(e) {
    const minimap = document.querySelector('.minimap');
    if (!minimap) return;

    const rect = minimap.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const scale = minimap.clientHeight / Math.max(totalHeight, 1);
    const scrollTop = y / scale - content.clientHeight / 2;

    // Cancel any previous click timeout to handle rapid clicks
    if (minimapClickTimeout) {
        clearTimeout(minimapClickTimeout);
    }

    // Prevent minimap re-render during click-initiated scroll
    minimapClickInProgress = true;

    content.scrollTo({ top: Math.max(0, scrollTop) });

    // Force immediate visible range update after scroll
    requestAnimationFrame(() => {
        const newRange = getVisibleRange(content.scrollTop, content.clientHeight);
        visibleRange = newRange;
        renderVisibleMessages();
        updateMinimapViewport(content.scrollTop, content.clientHeight);

        // Clear flag after scroll settles
        minimapClickTimeout = setTimeout(() => {
            minimapClickInProgress = false;
            minimapClickTimeout = null;

            // Render deferred minimap update if needed
            if (minimapNeedsRender) {
                minimapNeedsRender = false;
                lastMinimapHeight = totalHeight;
                lastMeasuredCount = messageHeights.size;
                renderMinimap();
            }
        }, 200);
    });
}

function renderSession(data) {
    const { session, messages } = data;
    allMessages = [...messages];
    if (sortNewestFirst) {
        allMessages.reverse();
    }
    selectedMessageIndex = -1;

    // Clear stale height cache from previous sessions
    messageHeights.clear();
    messageOffsets = [];
    lastMinimapHeight = 0;
    lastMeasuredCount = 0;

    // Calculate initial offsets (will use estimated heights)
    calculateOffsets();

    // Initial visible range
    visibleRange = getVisibleRange(0, content.clientHeight || 800);

    content.innerHTML = `
        <div class="content-wrapper">
            <div class="messages-container">
                <div class="messages" style="min-height: ${totalHeight}px;"></div>
            </div>
            <div class="minimap">
                <canvas></canvas>
                <div class="minimap-viewport"></div>
            </div>
        </div>
    `;

    // Render visible messages
    renderVisibleMessages();

    // Setup scroll handler
    content.removeEventListener('scroll', handleScroll);
    content.addEventListener('scroll', handleScroll, { passive: true });

    // Setup minimap
    const minimap = document.querySelector('.minimap');
    if (minimap) {
        minimap.addEventListener('click', handleMinimapClick);
    }

    // Render minimap after a brief delay to ensure heights are measured
    setTimeout(() => {
        calculateOffsets();
        updateContainerHeight();  // Update container with measured heights
        renderMinimap();
        updateMinimapViewport(content.scrollTop, content.clientHeight);
    }, 50);
}

function selectMessage(index, direction = 0) {
    if (allMessages.length === 0) return;

    index = Math.max(0, Math.min(index, allMessages.length - 1));
    selectedMessageIndex = index;

    // Check if the message is already visible in the viewport
    const msgOffset = messageOffsets[index] || 0;
    const msgHeight = messageHeights.get(allMessages[index]?.msg_id) || ESTIMATED_HEIGHT;
    const scrollTop = content.scrollTop;
    const viewportHeight = content.clientHeight;
    const isVisible = msgOffset >= scrollTop && (msgOffset + msgHeight) <= (scrollTop + viewportHeight);

    // Only scroll if the message is not visible
    if (!isVisible) {
        content.scrollTo({ top: Math.max(0, msgOffset - 100) });
    }

    // Update selection styling
    setTimeout(() => {
        const msgEl = document.getElementById(allMessages[index].msg_id);
        if (msgEl) {
            content.querySelectorAll('.message').forEach(m => m.classList.remove('selected'));
            msgEl.classList.add('selected');
        }
    }, 50);
}

function navigateMessages(direction) {
    if (allMessages.length === 0) return;

    if (selectedMessageIndex === -1) {
        selectMessage(direction > 0 ? 0 : allMessages.length - 1, direction);
    } else {
        selectMessage(selectedMessageIndex + direction, direction);
    }
}

function navigateSessions(direction) {
    if (sessions.length === 0) return;

    const currentIndex = currentSession
        ? sessions.findIndex(s => s.session_id === currentSession.session_id)
        : -1;

    let newIndex;
    if (currentIndex === -1) {
        newIndex = direction > 0 ? 0 : sessions.length - 1;
    } else {
        newIndex = Math.max(0, Math.min(currentIndex + direction, sessions.length - 1));
    }

    if (newIndex !== currentIndex) {
        loadSession(sessions[newIndex].session_id);
    }
}

function renderSearchResults(query, results) {
    if (results.length === 0) {
        content.innerHTML = `
            <div class="empty-state">
                <h2>No results</h2>
                <p>No messages found for "${escapeHtml(query)}"</p>
            </div>
        `;
        return;
    }

    content.innerHTML = `
        <div class="search-results">
            <h2>Search results for "${escapeHtml(query)}" (${results.length})</h2>
            ${results.map(r => `
                <div class="search-result" data-session="${r.session_id}" data-msg="${r.msg_id}">
                    <div class="search-result-meta">
                        <span class="badge">${escapeHtml(r.project)}</span>
                        <span>${escapeHtml(r.role)}</span>
                    </div>
                    <div>${safeSnippet(r.snippet) || escapeHtml(r.content.substring(0, 200))}</div>
                </div>
            `).join('')}
        </div>
    `;

    content.querySelectorAll('.search-result').forEach(item => {
        item.addEventListener('click', () => {
            loadSession(item.dataset.session, item.dataset.msg);
        });
    });
}

// Load functions
async function loadSessions() {
    allSessions = await fetchSessions();

    // Populate project filter dropdown safely (avoid XSS)
    const projects = await fetchProjects();

    // Reset selectedProject if it no longer exists
    if (selectedProject && !projects.includes(selectedProject)) {
        selectedProject = '';
    }

    projectFilter.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All projects';
    projectFilter.appendChild(allOption);
    for (const p of projects) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        opt.selected = p === selectedProject;
        projectFilter.appendChild(opt);
    }
    projectFilter.value = selectedProject;

    // Apply current filter
    filterSessions();
}

function filterSessions() {
    if (selectedProject) {
        sessions = allSessions.filter(s => s.project === selectedProject);
    } else {
        sessions = allSessions;
    }
    renderSessionList();
    statusText.textContent = `${sessions.length} sessions`;

    // If current session is no longer in filtered list, clear or select first
    if (currentSession && !sessions.find(s => s.session_id === currentSession.session_id)) {
        if (sessions.length > 0) {
            loadSession(sessions[0].session_id);
        } else {
            currentSession = null;
            currentSessionData = null;
            content.innerHTML = `
                <div class="empty-state">
                    <h2>No sessions</h2>
                    <p>No sessions match the current filter</p>
                </div>
            `;
        }
    }
}

async function loadSession(id, scrollToMsg = null) {
    const session = sessions.find(s => s.session_id === id);
    if (!session) return;

    // Clear any pending search timeout to prevent it from overwriting the session view
    if (searchTimeout) {
        clearTimeout(searchTimeout);
        searchTimeout = null;
    }

    currentSession = session;
    const messages = await fetchMessages(id);
    currentSessionData = { session, messages };
    renderSession(currentSessionData);
    renderSessionList();

    startWatching(id);

    if (scrollToMsg) {
        // Find message index and use selectMessage which handles virtual scrolling
        setTimeout(() => {
            const targetId = String(scrollToMsg);
            const msgIndex = allMessages.findIndex(m => String(m.msg_id) === targetId);
            if (msgIndex >= 0) {
                selectMessage(msgIndex);
            }
        }, 100);
    }
}

async function doSearch(query) {
    if (!query.trim()) {
        if (currentSession) {
            await loadSession(currentSession.session_id);
        } else {
            content.innerHTML = `
                <div class="empty-state">
                    <h2>Select a session</h2>
                    <p>Choose a session from the sidebar or search for messages</p>
                </div>
            `;
        }
        return;
    }

    const results = await searchMessages(query);
    renderSearchResults(query, results);
}

// Utilities
function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Safely render FTS snippet, only allowing <mark> tags
function safeSnippet(snippet) {
    if (!snippet) return '';
    // Escape everything first
    let safe = escapeHtml(snippet);
    // Then restore only <mark> and </mark> tags
    safe = safe.replace(/&lt;mark&gt;/g, '<mark>');
    safe = safe.replace(/&lt;\/mark&gt;/g, '</mark>');
    return safe;
}

function formatContent(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\[Thinking\]\n([\s\S]*?)(?=\n\[|$)/g,
        '<div class="thinking-block"><div class="thinking-label">Thinking</div>$1</div>');
    html = html.replace(/\[(Tool|Read|Write|Edit|Bash|Glob|Grep|Task|Question|Todo List|Entering Plan Mode|Exiting Plan Mode)([^\]]*)\]([\s\S]*?)(?=\n\[|\n\n|<div|$)/g,
        '<div class="tool-block">[$1$2]$3</div>');
    return html;
}

function formatDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString();
}

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString();
}

function formatAgentName(agent) {
    return { claude: 'Claude', codex: 'Codex' }[agent] || agent || 'Claude';
}

function openShortcutsModal() { shortcutsModal.classList.add('visible'); }
function closeShortcutsModal() { shortcutsModal.classList.remove('visible'); }

// Event handlers
searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => doSearch(e.target.value), 300);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !e.repeat) {
        e.preventDefault();
        clearTimeout(searchTimeout);
        searchTimeout = null;
        doSearch(searchInput.value);
    }
});

syncBtn.addEventListener('click', triggerSync);
sortBtn.addEventListener('click', toggleSort);
thinkingBtn.addEventListener('click', toggleThinking);
scrollTopBtn.addEventListener('click', () => content.scrollTo({ top: 0 }));
projectFilter.addEventListener('change', (e) => {
    selectedProject = e.target.value;
    filterSessions();
});
shortcutsBtn.addEventListener('click', openShortcutsModal);
modalClose.addEventListener('click', closeShortcutsModal);

shortcutsModal.addEventListener('click', (e) => {
    if (e.target === shortcutsModal) closeShortcutsModal();
});

document.addEventListener('keydown', (e) => {
    const isModalOpen = shortcutsModal.classList.contains('visible');
    const isInputFocused = document.activeElement === searchInput;

    if (e.key === 'Escape') {
        if (isModalOpen) {
            closeShortcutsModal();
            e.preventDefault();
        } else if (isInputFocused) {
            searchInput.value = '';
            searchInput.blur();
            doSearch('');
        }
        return;
    }

    if (isModalOpen) return;

    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
    }

    if (isInputFocused) return;

    if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        navigateMessages(1);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        navigateMessages(-1);
    } else if (e.key === ']') {
        e.preventDefault();
        navigateSessions(1);
    } else if (e.key === '[') {
        e.preventDefault();
        navigateSessions(-1);
    } else if (e.key === 'o') {
        e.preventDefault();
        toggleSort();
    } else if (e.key === 'r') {
        e.preventDefault();
        triggerSync();
    } else if (e.key === '?') {
        e.preventDefault();
        openShortcutsModal();
    }
});

// Initialize
(async () => {
    await loadSessions();
    if (sessions.length > 0) {
        await loadSession(sessions[0].session_id);
    }
})();

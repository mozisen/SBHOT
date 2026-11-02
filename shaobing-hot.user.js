// ==UserScript==
// @name         烧饼论坛热榜
// @namespace    https://sb.sb/
// @version      1.1.0
// @description  烧饼论坛侧栏官方热门主题：24 小时、30 天、全部，浏览/回复双榜。
// @author       烧饼热榜适配；原插件 https://www.nodeseek.com/space/10539
// @match        https://sb.sb/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @homepageURL  https://github.com/mozisen/SBHOT
// @supportURL   https://github.com/mozisen/SBHOT/issues
// @updateURL    https://raw.githubusercontent.com/mozisen/SBHOT/main/shaobing-hot.meta.js
// @downloadURL  https://raw.githubusercontent.com/mozisen/SBHOT/main/shaobing-hot.user.js
// @noframes
// @run-at       document-end
// @license      MIT
// ==/UserScript==

// Adapted from NodeSeek 热榜插件 1.1 (MIT): sidebar ranking and expand/collapse UI.
(function () {
    'use strict';
    const VERSION = '1.1.0';
    const UPDATE_INTERVAL = 60 * 60 * 1000;
    const UPDATE_META = 'https://raw.githubusercontent.com/mozisen/SBHOT/main/shaobing-hot.meta.js';
    const UPDATE_SCRIPT = 'https://raw.githubusercontent.com/mozisen/SBHOT/main/shaobing-hot.user.js';
    const UPDATE_KEY = 'sb-hot-update-v1';
    let checkingUpdate = false;
    let updateMessage = '';

    function newerVersion(candidate) {
        if (!/^\d+\.\d+\.\d+$/.test(candidate)) return false;
        const next = candidate.split('.').map(Number);
        const current = VERSION.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if (next[i] !== current[i]) return next[i] > current[i];
        }
        return false;
    }

    function readUpdateState() {
        try {
            const value = GM_getValue(UPDATE_KEY, {});
            return value && typeof value === 'object' ? value : {};
        } catch { return {}; }
    }

    function showUpdateState() {
        const target = document.querySelector('#sb-hot-panel .sb-hot-update');
        if (!target) return;
        target.replaceChildren();
        const saved = readUpdateState();
        if (newerVersion(String(saved.latest || ''))) {
            const link = element('a', '', `发现 v${saved.latest} · 安装更新`);
            link.href = UPDATE_SCRIPT;
            link.target = '_blank'; link.rel = 'noopener noreferrer';
            target.append(link);
            target.title = '后台自动安装由 Tampermonkey 设置控制；点击可立即进入安装页。';
        } else {
            target.textContent = updateMessage || `v${VERSION} · 每小时检查新版`;
            target.removeAttribute('title');
        }
    }

    // Version detection only. Tampermonkey owns installation and its update schedule.
    // Never evaluate fetched source or claim that opening an install URL installs it.
    function checkForUpdate(force = false) {
        if (checkingUpdate || typeof GM_xmlhttpRequest !== 'function' || typeof GM_setValue !== 'function') return;
        const saved = readUpdateState();
        const now = Date.now();
        const elapsed = now - Number(saved.lastAttempt);
        if (!force && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < UPDATE_INTERVAL) {
            showUpdateState(); return;
        }
        checkingUpdate = true;
        const attempted = { ...saved, lastAttempt: now };
        try { GM_setValue(UPDATE_KEY, attempted); } catch { /* Current page still checks; no persistent throttle available. */ }
        const finish = message => { checkingUpdate = false; updateMessage = message; showUpdateState(); };
        if (force) { updateMessage = '正在检查新版…'; showUpdateState(); }
        try {
            GM_xmlhttpRequest({
                method: 'GET', url: `${UPDATE_META}?t=${now}`, timeout: 15000, anonymous: true,
                onload: response => {
                    const body = String(response.responseText || '');
                    const version = body.match(/^\/\/\s*@version\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
                    const name = body.match(/^\/\/\s*@name\s+(.+)$/m)?.[1]?.trim();
                    const namespace = body.match(/^\/\/\s*@namespace\s+(.+)$/m)?.[1]?.trim();
                    let sourceOK = false;
                    try {
                        const finalUrl = new URL(response.finalUrl || UPDATE_META);
                        sourceOK = finalUrl.origin === new URL(UPDATE_META).origin && finalUrl.pathname === new URL(UPDATE_META).pathname;
                    } catch { /* Reject unexpected redirects. */ }
                    if (response.status !== 200 || !sourceOK || !body.startsWith('// ==UserScript==') || !body.includes('// ==/UserScript==') || !version || name !== '烧饼论坛热榜' || namespace !== 'https://sb.sb/') {
                        finish('版本检查失败 · 稍后重试'); return;
                    }
                    try { GM_setValue(UPDATE_KEY, { lastAttempt: now, checkedAt: Date.now(), latest: version }); } catch { /* Do not break ranking UI. */ }
                    finish(newerVersion(version) ? '' : `v${VERSION} · 已检查新版`);
                },
                onerror: () => finish('版本检查失败 · 稍后重试'),
                ontimeout: () => finish('版本检查超时 · 稍后重试'),
                onabort: () => finish('版本检查已取消')
            });
        } catch { finish('版本检查失败 · 稍后重试'); }
    }
    const PERIODS = [
        { label: '24 小时', path: '/pages/top/' },
        { label: '30 天', path: '/pages/top/30d/' },
        { label: '全部', path: '/pages/top/all/' }
    ];
    const TTL = 15 * 60 * 1000;
    const LIMIT = 10;
    const cache = new Map();
    const pending = new Map();
    let period = 0, metric = 'replies', expanded = false, revision = 0;
    let panel, list, status, toggle, refresh, source;

    // Treat downloaded HTML as data. Only validated topic paths leave this parser.
    function parseBoards(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const boards = {};
        for (const section of doc.querySelectorAll('.top-board')) {
            const heading = section.querySelector('.top-board-title')?.textContent.replace(/\s+/g, '') || '';
            const key = /^热门主题[·・]浏览$/.test(heading) ? 'views'
                : /^热门主题[·・]回复$/.test(heading) ? 'replies' : null;
            if (!key) continue;
            const seen = new Set();
            boards[key] = [];
            const rows = section.querySelectorAll('.top-row');
            for (const row of rows) {
                const link = row.querySelector('a.top-thread-title[href]');
                if (!link) continue;
                let url;
                try { url = new URL(link.getAttribute('href'), location.origin); } catch { continue; }
                if (url.origin !== location.origin || !/^\/t\/\d+\/$/.test(url.pathname) || seen.has(url.pathname)) continue;
                const title = link.textContent.trim();
                const score = row.querySelector('.top-score')?.cloneNode(true);
                score?.querySelectorAll('.top-unit').forEach(el => el.remove());
                const rawCount = score?.textContent.trim().replace(/,/g, '') || '';
                if (!title || !/^\d+$/.test(rawCount)) continue;
                seen.add(url.pathname);
                boards[key].push({ href: url.pathname, title, count: Number(rawCount),
                    author: row.querySelector('.top-by')?.textContent.trim() || '',
                    forum: row.querySelector('.top-node')?.textContent.trim() || '' });
            }
            if (rows.length && !boards[key].length) throw new Error('榜单格式已变化');
        }
        if (!boards.views || !boards.replies) throw new Error('未找到官方热门主题榜单');
        return boards;
    }

    async function fetchBoards(index, force = false) {
        if (pending.has(index)) return pending.get(index);
        const saved = cache.get(index);
        if (!force && saved && Date.now() - saved.at < TTL) return saved;
        const request = (async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
                const response = await fetch(PERIODS[index].path, {
                    credentials: 'same-origin', cache: 'no-store', signal: controller.signal
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const finalUrl = new URL(response.url, location.origin);
                if (finalUrl.origin !== location.origin || finalUrl.pathname !== PERIODS[index].path) {
                    throw new Error('请求被重定向，请检查登录状态');
                }
                const result = { boards: parseBoards(await response.text()), at: Date.now() };
                cache.set(index, result);
                return result;
            } finally { clearTimeout(timeout); }
        })();
        pending.set(index, request);
        try { return await request; } finally { pending.delete(index); }
    }

    function element(tag, className, text) {
        const el = document.createElement(tag);
        el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    function render(result) {
        list.replaceChildren();
        const posts = result.boards[metric];
        if (!posts.length) list.append(element('li', 'sb-hot-message', '该时段暂无热门主题'));
        posts.forEach((post, index) => {
            const li = element('li', 'sb-hot-item');
            li.hidden = !expanded && index >= LIMIT;
            const link = element('a', 'sb-hot-link');
            link.href = post.href;
            link.title = `${post.title}\n作者：${post.author || '未知'} · ${post.forum}\n${PERIODS[period].label}${metric === 'views' ? '浏览' : '回复'}：${post.count}`;
            link.append(element('span', `sb-hot-rank sb-hot-rank-${index + 1}`, String(index + 1)),
                element('span', 'sb-hot-title', post.title), element('span', 'sb-hot-count', String(post.count)));
            li.append(link);
            list.append(li);
        });
        toggle.hidden = posts.length <= LIMIT;
        toggle.textContent = expanded ? '收起榜单 ▴' : '展开全部 ▾';
        toggle.setAttribute('aria-expanded', String(expanded));
    }

    async function update(force = false) {
        const token = ++revision;
        const index = period;
        source.href = PERIODS[index].path;
        panel.querySelectorAll('[data-period]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.period) === period)));
        panel.querySelectorAll('[data-metric]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.metric === metric)));
        status.classList.remove('sb-hot-error');
        status.removeAttribute('title');
        status.textContent = '正在更新…';
        panel.setAttribute('aria-busy', 'true');
        refresh.disabled = true;
        const saved = cache.get(index);
        if (saved) render(saved);
        else { list.replaceChildren(element('li', 'sb-hot-message', '正在读取官方热榜…')); toggle.hidden = true; }
        try {
            const result = await fetchBoards(index, force);
            if (token !== revision) return;
            render(result);
            status.textContent = `${new Date(result.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 获取`;
        } catch (error) {
            if (token !== revision) return;
            status.classList.add('sb-hot-error');
            status.textContent = saved ? '更新失败 · 显示上次数据' : '获取失败 · 点击刷新重试';
            status.title = error.name === 'AbortError' ? '请求超时' : error.message;
            if (!saved) list.replaceChildren(element('li', 'sb-hot-message', '暂时无法读取官方榜单'));
        } finally {
            if (token === revision) { refresh.disabled = false; panel.setAttribute('aria-busy', 'false'); }
        }
    }

    function mount() {
        if (document.getElementById('sb-hot-panel')) return;
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        panel = element('section', 'card sidebar-card sb-hot-panel');
        panel.id = 'sb-hot-panel';
        panel.setAttribute('aria-label', '烧饼论坛热榜');
        // Static markup only; all downloaded content is rendered with textContent.
        panel.innerHTML = `<div class="sb-hot-header"><a class="sb-hot-source" href="/pages/top/">烧饼热榜</a><button type="button" class="sb-hot-refresh" aria-label="刷新热榜" title="刷新热榜">↻</button></div>
            <div class="sb-hot-periods" role="group" aria-label="榜单时间范围">${PERIODS.map((p, i) => `<button type="button" data-period="${i}" aria-pressed="${i === 0}">${p.label}</button>`).join('')}</div>
            <div class="sb-hot-metrics" role="group" aria-label="排序依据"><button type="button" data-metric="replies" aria-pressed="true">回复热度</button><button type="button" data-metric="views" aria-pressed="false">浏览热度</button></div>
            <ol class="sb-hot-list" id="sb-hot-list"></ol><div class="sb-hot-footer"><span class="sb-hot-status" role="status" aria-live="polite"></span><button type="button" class="sb-hot-toggle" aria-controls="sb-hot-list" aria-expanded="false" hidden>展开全部 ▾</button></div><p class="sb-hot-note">官方榜单 · 每 15 分钟更新</p>`;
        const userCard = sidebar.querySelector('.user-card');
        if (userCard?.parentElement === sidebar) userCard.after(panel);
        else sidebar.prepend(panel);
        list = panel.querySelector('.sb-hot-list'); status = panel.querySelector('.sb-hot-status');
        toggle = panel.querySelector('.sb-hot-toggle'); refresh = panel.querySelector('.sb-hot-refresh');
        source = panel.querySelector('.sb-hot-source');
        const updateNote = element('p', 'sb-hot-note sb-hot-update');
        updateNote.setAttribute('role', 'status');
        panel.append(updateNote);
        showUpdateState();
        panel.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
            period = Number(button.dataset.period); expanded = false; update();
        }));
        panel.querySelectorAll('[data-metric]').forEach(button => button.addEventListener('click', () => {
            metric = button.dataset.metric; expanded = false; update();
        }));
        refresh.addEventListener('click', () => update(true));
        toggle.addEventListener('click', () => { expanded = !expanded; const saved = cache.get(period); if (saved) render(saved); });
        update();
    }

    GM_addStyle(`
        #sb-hot-panel { padding:0; overflow:hidden; background:var(--panel,#fff); color:var(--text,#222); border:1px solid var(--line,#ddd); border-radius:12px; margin-bottom:16px; }
        #sb-hot-panel * { box-sizing:border-box; }
        #sb-hot-panel button { font:inherit; cursor:pointer; border:0; color:inherit; background:transparent; min-height:44px; border-radius:7px; }
        #sb-hot-panel button:focus-visible,#sb-hot-panel a:focus-visible { outline:2px solid var(--focus-ring,#222); outline-offset:-2px; }
        #sb-hot-panel button:hover { background:var(--panel-hover,#f2f4f7); }
        #sb-hot-panel button:disabled { opacity:.5; cursor:wait; }
        #sb-hot-panel [hidden] { display:none!important; }
        #sb-hot-panel .sb-hot-header { display:flex; align-items:center; justify-content:space-between; padding:4px 12px; }
        #sb-hot-panel .sb-hot-source { color:inherit; font-size:15px; font-weight:700; text-decoration:none; }
        #sb-hot-panel .sb-hot-refresh { width:44px; font-size:24px; }
        #sb-hot-panel .sb-hot-periods { display:flex; margin:0 12px; padding:3px; background:var(--panel-alt,#fafbfc); border:1px solid var(--line,#ddd); border-radius:9px; }
        #sb-hot-panel .sb-hot-periods button { flex:1; min-width:0; padding:0 6px; white-space:nowrap; font-size:13px; }
        #sb-hot-panel .sb-hot-periods [aria-pressed=true] { background:var(--mark,#ffd02f); color:var(--mark-text,#222); font-weight:700; }
        #sb-hot-panel .sb-hot-metrics { display:flex; gap:8px; padding:0 12px; color:var(--text-muted,#555); }
        #sb-hot-panel .sb-hot-metrics button { flex:1; font-size:12px; }
        #sb-hot-panel .sb-hot-metrics [aria-pressed=true] { color:var(--text,#222); font-weight:700; text-decoration:underline; text-decoration-color:var(--mark,#ffd02f); text-underline-offset:5px; }
        #sb-hot-panel .sb-hot-list { list-style:none; padding:0; margin:0; }
        #sb-hot-panel .sb-hot-item { border-top:1px solid var(--line-soft,#eee); margin:0; padding:0; }
        #sb-hot-panel .sb-hot-link { display:flex; align-items:center; gap:9px; padding:10px 12px; min-height:44px; color:inherit; text-decoration:none; }
        #sb-hot-panel .sb-hot-link:hover { background:var(--panel-hover,#f2f4f7); }
        #sb-hot-panel .sb-hot-rank { flex-shrink:0; display:grid; place-items:center; width:20px; height:20px; border-radius:5px; font-size:12px; background:var(--panel-alt,#fafbfc); color:var(--text-muted,#555); }
        #sb-hot-panel .sb-hot-rank-1 { background:#c62828; color:white; }
        #sb-hot-panel .sb-hot-rank-2 { background:#ad4510; color:white; }
        #sb-hot-panel .sb-hot-rank-3 { background:#8a6500; color:white; }
        #sb-hot-panel .sb-hot-title { flex:1; min-width:0; font-size:13px; line-height:1.6; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        #sb-hot-panel .sb-hot-count { font-size:12px; color:var(--text-muted,#555); font-variant-numeric:tabular-nums; }
        #sb-hot-panel .sb-hot-footer { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:0 12px; min-height:44px; border-top:1px solid var(--line,#ddd); font-size:12px; color:var(--text-muted,#555); }
        #sb-hot-panel .sb-hot-toggle { flex-shrink:0; padding:0 4px; }
        #sb-hot-panel .sb-hot-note { margin:0; padding:0 12px 10px; font-size:12px; color:var(--text-muted,#555); }
        #sb-hot-panel .sb-hot-message { padding:32px 12px; text-align:center; font-size:13px; color:var(--text-muted,#555); }
        #sb-hot-panel .sb-hot-error { color:var(--danger,#cf2b2b); }
    `);
    mount();
    // The forum can replace sidebar content during navigation. Only remount when necessary.
    const observer = new MutationObserver(() => { if (!document.getElementById('sb-hot-panel')) mount(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const refreshIfStale = () => {
        if (!document.hidden && panel?.isConnected && Date.now() - (cache.get(period)?.at || 0) >= TTL) update();
    };
    setInterval(refreshIfStale, TTL);
    document.addEventListener('visibilitychange', refreshIfStale);
    checkForUpdate();
    // Poll the shared timestamp each minute so navigation does not restart the one-hour window.
    setInterval(() => checkForUpdate(), 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('检查烧饼热榜更新', () => checkForUpdate(true));
    }
})();

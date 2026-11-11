// ==UserScript==
// @name         烧饼论坛热榜
// @namespace    https://sb.sb/
// @version      2.2.0
// @description  烧饼论坛热榜：日/月榜优先官方，实时/周榜后台统计，低负载混合模式。
// @author       烧饼热榜适配；原插件 https://www.nodeseek.com/space/10539
// @match        https://sb.sb/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      sbhot.voee.de
// @homepageURL  https://github.com/mozisen/SBHOT
// @supportURL   https://github.com/mozisen/SBHOT/issues
// @updateURL    https://sbhot.voee.de/shaobing-hot.meta.js
// @downloadURL  https://sbhot.voee.de/shaobing-hot.user.js
// @noframes
// @run-at       document-end
// @license      MIT
// ==/UserScript==

// Adapted from NodeSeek 热榜插件 1.1 (MIT): sidebar ranking and expand/collapse UI.
(function () {
    'use strict';
    const VERSION = '2.2.0';
    // Reuse the forum's yellow SB brand mark (https://sb.sb/).
    const LOGO = "<svg class=\"sb-hot-logo\" viewBox=\"0 0 46 46\" width=\"26\" height=\"26\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M0 0H46V14l-6 9 6 9V46H0V32l6-9-6-9z\" fill=\"#FFD02F\"></path><path d=\"M16.74 30.64Q15.04 30.64 13.74 30.04 12.43 29.43 11.7 28.29 10.96 27.16 10.96 25.56v-.59h2.73v.59q0 1.33.82 1.99t2.23.66q1.43.0 2.13-.57T19.57 26.19Q19.57 25.58 19.23 25.21 18.88 24.83 18.22 24.59 17.56 24.34 16.61 24.13L16.13 24.03Q14.62 23.69 13.54 23.18q-1.09-.52-1.66-1.36-.58-.84-.58-2.18Q11.3 18.3 11.94 17.34 12.58 16.38 13.75 15.87q1.16-.51 2.74-.51Q18.06 15.36 19.29 15.89 20.52 16.43 21.22 17.49 21.93 18.55 21.93 20.14V20.77H19.2V20.14Q19.2 19.3 18.87 18.79 18.54 18.27 17.94 18.03 17.33 17.79 16.49 17.79 15.23 17.79 14.63 18.26 14.03 18.74 14.03 19.56 14.03 20.1 14.31 20.48 14.6 20.86 15.16 21.11 15.73 21.36 16.61 21.55L17.09 21.66Q18.67 21.99 19.84 22.52q1.16.52 1.81 1.38Q22.3 24.76 22.3 26.11q0 1.34-.68 2.36t-1.93 1.6q-1.25.57-2.95.57zM30.59 30.35H22.94V27.91h1.93V18.09H22.94V15.65H30.5Q31.84 15.65 32.84 16.1 33.84 16.55 34.4 17.38 34.95 18.21 34.95 19.37V19.58Q34.95 20.59 34.58 21.23 34.2 21.87 33.68 22.21 33.17 22.56 32.71 22.71V23.08Q33.17 23.21 33.71 23.56 34.26 23.9 34.65 24.55 35.04 25.21 35.04 26.26V26.46q0 1.22-.57 2.09Q33.9 29.43 32.91 29.89 31.91 30.35 30.59 30.35zm-2.94-6.13v3.61h2.6Q31.15 27.83 31.71 27.39 32.27 26.95 32.27 26.13V25.92Q32.27 25.1 31.72 24.66 31.17 24.22 30.25 24.22h-2.6zm0-6.05V21.7h2.56Q31.07 21.7 31.62 21.26 32.18 20.82 32.18 20.04V19.83Q32.18 19.03 31.63 18.6 31.09 18.17 30.21 18.17H27.65z\" fill=\"#111\"></path></svg>";
    const UPDATE_INTERVAL = 60 * 60 * 1000;
    const SERVICE = 'https://sbhot.voee.de';
    const UPDATE_META = `${SERVICE}/shaobing-hot.meta.js`;
    const UPDATE_SCRIPT = `${SERVICE}/shaobing-hot.user.js`;
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
        const target = document.querySelector('#sb-hot-panel .sb-hot-refresh');
        if (!target) return;
        const saved = readUpdateState();
        target.title = '刷新热榜\n' + (newerVersion(String(saved.latest || ''))
            ? `发现 v${saved.latest} · 可通过 Tampermonkey 更新`
            : updateMessage || `v${VERSION} · 每小时检查新版`);
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
        { label: '实时', key: 'realtime' },
        { label: '24小时', key: 'daily' },
        { label: '周榜', key: 'weekly' },
        { label: '30天榜', key: 'monthly' }
    ];
    const TTL = 60 * 1000;
    const LIMIT = 10;
    const cache = new Map();
    const pending = new Map();
    let period = 0, metric = 'replies', expanded = false, revision = 0;
    let panel, list, status, toggle, refresh, source;

    // Treat backend JSON as untrusted data; never insert downloaded HTML.
    function parseRanking(data, key) {
        if (!data || data.schema_version !== 1 || data.period !== key || !data.status ||
            typeof data.status.baseline_complete !== 'boolean' || typeof data.status.stale !== 'boolean' ||
            typeof data.warming_up !== 'boolean' || !Number.isFinite(data.observed_seconds) || data.observed_seconds < 0 ||
            !(data.updated_at === null || Number.isFinite(data.updated_at) && data.updated_at > 0)) {
            throw new Error('热榜数据格式不正确');
        }
        const boards = {};
        for (const metric of ['views', 'replies']) {
            const rows = data.boards?.[metric];
            if (!Array.isArray(rows) || rows.length > 100) throw new Error('榜单格式不正确');
            const seen = new Set();
            boards[metric] = [];
            for (const row of rows) {
                if (!row || typeof row.href !== 'string' || !/^\/t\/\d+\/$/.test(row.href) ||
                    typeof row.title !== 'string' || !row.title.trim() ||
                    !Number.isSafeInteger(row.count) || row.count < 0) throw new Error('主题数据不正确');
                if (seen.has(row.href)) continue;
                seen.add(row.href);
                boards[metric].push({ href: row.href, title: row.title, count: row.count,
                    author: typeof row.author === 'string' ? row.author : '',
                    forum: typeof row.forum === 'string' ? row.forum : '' });
            }
        }
        return { ...data, boards, at: Date.now() };
    }

    async function fetchBoards(index, force = false) {
        if (pending.has(index)) return pending.get(index);
        const saved = cache.get(index);
        if (!force && saved && Date.now() - saved.at < TTL) return saved;
        const url = `${SERVICE}/api/rankings/${PERIODS[index].key}`;
        const request = new Promise((resolve, reject) => {
            GM_xmlhttpRequest({ method: 'GET', url, anonymous: true, timeout: 15000,
                onload: response => {
                    try {
                        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
                        if ((response.finalUrl || url) !== url) throw new Error('热榜请求被重定向');
                        const result = parseRanking(JSON.parse(response.responseText), PERIODS[index].key);
                        cache.set(index, result); resolve(result);
                    } catch (error) { reject(error); }
                },
                onerror: () => reject(new Error('无法连接热榜服务')),
                ontimeout: () => reject(new Error('热榜请求超时')),
                onabort: () => reject(new Error('热榜请求已取消'))
            });
        });
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
        const official = result.source === 'official';
        if (!posts.length) list.append(element('li', 'sb-hot-message', official ? '该时段暂无官方热门主题' : result.status.baseline_complete ? '该时段暂无观测到的新增热度' : '正在建立全站基线，稍后开始统计'));
        const hours = Math.floor(result.observed_seconds / 3600);
        source.href = official ? `https://sb.sb/pages/top/${period === 3 ? '30d/' : ''}` : SERVICE;
        status.title = official ?
            (result.status.stale || result.status.refresh_error ? '官方同步延迟 · 显示上次榜单' : '官方榜单 · 每15分钟同步') :
            !result.status.baseline_complete ? '正在建立全站基线' :
            result.status.stale ? '采集延迟 · 暂显示已有统计' :
            result.coverage_gap ? '统计区间存在采集中断' :
            result.warming_up ? `统计积累中 · 已记录${hours ? `${hours}小时` : `${Math.floor(result.observed_seconds / 60)}分钟`}` :
            '服务端快照统计 · 实时为近1小时';
        if (official && typeof result.metric_notes?.[metric] === 'string') status.title += '\n' + result.metric_notes[metric];
        posts.forEach((post, index) => {
            const li = element('li', 'sb-hot-item');
            li.hidden = !expanded && index >= LIMIT;
            const link = element('a', 'sb-hot-link');
            link.href = post.href;
            link.title = `${post.title}\n作者：${post.author || '未知'} · ${post.forum}\n${PERIODS[period].label}${metric === 'views' ? '浏览' : '回复'}${official ? '官方统计' : '观测增量'}：${post.count}${official && typeof result.metric_notes?.[metric] === 'string' ? '\n' + result.metric_notes[metric] : ''}`;
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
        source.href = SERVICE;
        panel.querySelectorAll('[data-period]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.period) === period)));
        panel.querySelectorAll('[data-metric]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.metric === metric)));
        status.classList.remove('sb-hot-error');
        status.removeAttribute('title');
        status.textContent = '正在更新…';
        panel.setAttribute('aria-busy', 'true');
        refresh.disabled = true;
        const saved = cache.get(index);
        if (saved) render(saved);
        else { list.replaceChildren(element('li', 'sb-hot-message', '正在读取热榜…')); toggle.hidden = true; status.title = '服务端持续统计'; }
        try {
            const result = await fetchBoards(index, force);
            if (token !== revision) return;
            render(result);
            status.textContent = result.updated_at ? `${new Date(result.updated_at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${result.source === 'official' ? '同步' : '采集'}` : '等待首次采集';
        } catch (error) {
            if (token !== revision) return;
            status.classList.add('sb-hot-error');
            status.textContent = saved ? '更新失败 · 显示上次数据' : '获取失败 · 点击刷新重试';
            status.title = error.name === 'AbortError' ? '请求超时' : error.message;
            if (!saved) list.replaceChildren(element('li', 'sb-hot-message', '暂时无法读取热榜'));
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
        panel.innerHTML = `<div class="sb-hot-header"><a class="sb-hot-source" href="https://sbhot.voee.de/">${LOGO}<span>烧饼热榜</span></a><button type="button" class="sb-hot-refresh" aria-label="刷新热榜" title="刷新热榜">↻</button></div>
            <div class="sb-hot-periods" role="group" aria-label="榜单时间范围">${PERIODS.map((p, i) => `<button type="button" data-period="${i}" aria-pressed="${i === 0}">${p.label}</button>`).join('')}</div>
            <div class="sb-hot-metrics" role="group" aria-label="排序依据"><button type="button" data-metric="replies" aria-pressed="true">回复热度</button><button type="button" data-metric="views" aria-pressed="false">浏览热度</button></div>
            <ol class="sb-hot-list" id="sb-hot-list"></ol><div class="sb-hot-footer"><span class="sb-hot-status" role="status" aria-live="polite"></span><button type="button" class="sb-hot-toggle" aria-controls="sb-hot-list" aria-expanded="false" hidden>展开全部 ▾</button></div>`;
        const userCard = sidebar.querySelector('.user-card');
        if (userCard?.parentElement === sidebar) userCard.after(panel);
        else sidebar.prepend(panel);
        list = panel.querySelector('.sb-hot-list'); status = panel.querySelector('.sb-hot-status');
        toggle = panel.querySelector('.sb-hot-toggle'); refresh = panel.querySelector('.sb-hot-refresh');
        source = panel.querySelector('.sb-hot-source');
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
        #sb-hot-panel .sb-hot-source { display:inline-flex; align-items:center; gap:8px; color:inherit; font-size:15px; font-weight:700; text-decoration:none; }
        #sb-hot-panel .sb-hot-logo { display:block; flex:none; width:26px; height:26px; }
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
        #sb-hot-panel .sb-hot-message { padding:32px 12px; text-align:center; font-size:13px; color:var(--text-muted,#555); }
        #sb-hot-panel .sb-hot-error { color:var(--danger,#cf2b2b); }
    `);
    // Independent of the sidebar: topic pages can use a layout without a sidebar.
    function replyGuardUid(link) {
        try {
            const url = new URL(link?.getAttribute('href') || '', location.origin);
            return url.origin === location.origin ? url.pathname.match(/^\/u\/(\d+)\/$/)?.[1] || '' : '';
        } catch (_) { return ''; }
    }

    function replyGuardAccount(root = document) {
        const links = [...root.querySelectorAll('.top .nav-mine[href], .top .nav-user-links a.nav-user-item[href], .mobile-menu-section a.mobile-menu-link[href^="/u/"]')]
            .filter(link => !link.closest('.post-content, article, blockquote'));
        const uids = [...new Set(links.map(replyGuardUid).filter(Boolean))];
        return uids.length === 1 ? uids[0] : '';
    }

    function replyGuardAuthor(post) {
        if (!post) return '';
        if (/^\d+$/.test(post.dataset.authorUid || '')) return post.dataset.authorUid;
        const link = [...post.querySelectorAll('a.post-author[href], .post-author-col a[href]')].find(a =>
            (!a.closest('[data-reply-no]') || a.closest('[data-reply-no]') === post) &&
            !a.closest('.post-content, .floor-box-to, blockquote, .quote, .post-sig'));
        return replyGuardUid(link);
    }

    function replyGuardRows(root) {
        return [...root.querySelectorAll('#replies [data-reply-no], .topic-replies [data-reply-no]')]
            .filter(post => post.matches('.post-item, .floor-box-item'));
    }

    function replyGuardDecision(pages, thread, uid) {
        const owner = replyGuardAuthor(pages[0].querySelector(`#post-${thread}`));
        if (!owner) throw new Error('无法识别楼主');
        if (owner === uid) return false;
        const rows = new Map();
        for (const page of pages) {
            if (replyGuardAuthor(page.querySelector(`#post-${thread}`)) !== owner) throw new Error('帖子结构已变化');
            for (const post of replyGuardRows(page)) rows.set(post.dataset.replyNo, post);
        }
        const posts = [...rows.values()];
        if (posts.some(post => !replyGuardAuthor(post))) throw new Error('部分回复作者不可见');
        const expected = Math.max(0, ...pages.map(page => {
            const count = page.querySelector('.post-content-stats')?.querySelectorAll('span')[1]?.textContent.replace(/,/g, '').trim();
            return /^\d+$/.test(count || '') ? Number(count) : 0;
        }));
        if (posts.length < expected) throw new Error('部分回复尚未加载或不可见');
        const own = posts.filter(post => replyGuardAuthor(post) === uid);
        if (!own.length) return false;
        const last = Math.max(...own.map(post => Number(post.dataset.replyNo)));
        const ownFloors = new Set(own.map(post => post.dataset.replyNo));
        const ownIds = new Set(own.map(post => post.id.match(/^post-(\d+)$/)?.[1]).filter(Boolean));
        const answered = posts.some(post => {
            if (Number(post.dataset.replyNo) <= last || replyGuardAuthor(post) !== owner) return false;
            // A nested child's links and quoted old text are not the parent's response.
            const links = [...post.querySelectorAll('a[href]')].filter(link =>
                link.closest('[data-reply-no]') === post && !link.closest('blockquote, .quote, .quote-threads-reference, .reply-reference, .post-sig, .signature'));
            if (links.some(link => {
                if (link.closest('.floor-box-to') && replyGuardUid(link) === uid) return true;
                if (link.closest('.post-content, .floor-box-body') && link.textContent.trim().startsWith('@') && replyGuardUid(link) === uid) return true;
                if (!link.closest('.post-content, .floor-box-body')) return false;
                try {
                    const url = new URL(link.getAttribute('href'), location.origin);
                    return url.origin === location.origin && url.pathname === `/t/${thread}/` &&
                        (ownFloors.has(url.searchParams.get('reply')) || ownIds.has(url.searchParams.get('reply_id')));
                } catch (_) { return false; }
            })) return true;
            if (post.matches('.floor-box-item') && !post.querySelector('.floor-box-to')) {
                const parent = post.closest('.floor-box')?.parentElement?.closest('.post-item[data-reply-no]');
                return replyGuardAuthor(parent) === uid;
            }
            return false;
        });
        return !answered;
    }

    async function replyGuardCheck(thread, uid) {
        // Only on submit; no background collection or personal data sent to the ranking server.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const pending = [`/t/${thread}/`], seen = new Set(), pages = [];
        const pathPattern = new RegExp(`^/t/${thread}/(?:page/[1-9]\\d*/)?$`);
        try {
            while (pending.length) {
                if (seen.size >= 10) throw new Error('本帖超过 10 页');
                const path = pending.shift();
                seen.add(path);
                const response = await fetch(new URL(path, location.origin).href, {
                    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal
                });
                if (!response.ok || response.url && new URL(response.url).pathname !== path) throw new Error('论坛读取失败');
                const html = await response.text();
                if (html.length > 4000000) throw new Error('页面过大');
                const page = new DOMParser().parseFromString(html, 'text/html');
                if (!page.querySelector('#replies, .topic-replies') || replyGuardAccount(page) !== uid) throw new Error('登录状态或页面结构已变化');
                pages.push(page);
                for (const link of page.querySelectorAll('#replies .pagination a[href], .topic-replies .pagination a[href]')) {
                    if (link.closest('[data-reply-no], .post-content, blockquote')) continue;
                    const url = new URL(link.getAttribute('href'), location.origin);
                    if (url.origin !== location.origin || !pathPattern.test(url.pathname)) throw new Error('分页地址异常');
                    if (!seen.has(url.pathname) && !pending.includes(url.pathname)) pending.push(url.pathname);
                }
            }
            return replyGuardDecision(pages, thread, uid);
        } finally { clearTimeout(timer); }
    }

    const replyGuardPending = new WeakSet();
    let replyGuardPermit = null;
    document.addEventListener('submit', async event => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || !form.querySelector('textarea#reply-body[name="body"]') || !form.closest('#reply, .reply-panel')) return;
        if (replyGuardPermit === form) { replyGuardPermit = null; return; }
        const thread = location.pathname.match(/^\/t\/(\d+)\/(?:page\/\d+\/)?$/)?.[1];
        if (!thread) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (replyGuardPending.has(form)) return;
        replyGuardPending.add(form);
        const uid = replyGuardAccount(), href = location.href, submitter = event.submitter;
        // FormData also includes reply target and editor mode; a changed draft needs a new check.
        const signature = () => JSON.stringify([...new FormData(form)].map(([key, value]) => [key, typeof value === 'string' ? value : [value.name, value.size, value.lastModified]]));
        const original = signature();
        let edited = false;
        const onEdit = () => { edited = true; };
        form.addEventListener('input', onEdit, true);
        const unchanged = () => !edited && form.isConnected && location.href === href && replyGuardAccount() === uid && signature() === original;
        const notice = document.createElement('span');
        notice.setAttribute('role', 'status');
        notice.textContent = ' 正在核对楼主是否已回复你…';
        form.appendChild(notice);
        try {
            let message = '';
            try {
                if (!uid) throw new Error('无法识别当前账号');
                if (await replyGuardCheck(thread, uid)) message = '你已经回复过这个帖子，但楼主在你最近一次回复后尚未直接回复你。\n\n仍要发送这条回复吗？\n选择“取消”将保留草稿。';
            } catch (_) {
                message = '暂时无法完整核实本帖的回复记录（网络、登录状态或分页限制）。\n\n仍要发送这条回复吗？\n选择“取消”将保留草稿。';
            }
            if (!unchanged()) return;
            if (message && !window.confirm(message)) return;
            if (!unchanged()) return;
            replyGuardPermit = form;
            // Let the forum perform its own validation and submission, exactly once.
            try { HTMLFormElement.prototype.requestSubmit.call(form, submitter?.form === form ? submitter : undefined); }
            finally { replyGuardPermit = null; }
        } finally {
            form.removeEventListener('input', onEdit, true);
            notice.remove();
            replyGuardPending.delete(form);
        }
    }, true);

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

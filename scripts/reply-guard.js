// Shared, build-time embedded module. No remote runtime dependency.
(function installReplyGuard() {
    'use strict';
    if (document.documentElement.hasAttribute('data-sb-reply-guard')) return;
    document.documentElement.setAttribute('data-sb-reply-guard', '1.01');
    GM_addStyle(`
        dialog.sb-reply-dialog { position:fixed!important; inset:0!important; margin:auto!important;
            box-sizing:border-box; width:min(440px,calc(100vw - 32px)); height:fit-content;
            max-height:calc(100dvh - 32px); overflow:auto; padding:24px; border:1px solid var(--line,#ddd);
            border-radius:16px; background:var(--panel,#fff); color:var(--text,#222);
            box-shadow:0 16px 60px #0004; font:15px/1.7 system-ui,sans-serif; text-align:left; }
        dialog.sb-reply-dialog::backdrop { background:rgba(0,0,0,.48); }
        .sb-reply-dialog h2 { margin:0 0 12px; font:700 19px/1.4 system-ui,sans-serif; color:inherit; }
        .sb-reply-dialog p { white-space:pre-line; margin:0; color:inherit; overflow-wrap:anywhere; }
        .sb-reply-dialog .sb-reply-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:22px; }
        .sb-reply-dialog button { box-sizing:border-box; min-height:44px; padding:8px 18px; border:1px solid var(--line,#ccc);
            border-radius:9px; font:600 14px/1.5 system-ui,sans-serif; background:var(--panel-alt,#f5f5f5); color:inherit; cursor:pointer; }
        .sb-reply-dialog button[data-continue] { background:#ffd02f; color:#222; border-color:#d6aa11; }
        .sb-reply-dialog button:focus-visible { outline:3px solid #3378cf; outline-offset:3px; }
        @media(prefers-color-scheme:dark) { dialog.sb-reply-dialog { background:var(--panel,#202124); color:var(--text,#eee); }
            .sb-reply-dialog button { background:var(--panel-alt,#303134); } }
    `);
    function replyGuardConfirm(message) {
        return new Promise(resolve => {
            const previous = document.activeElement;
            const dialog = document.createElement('dialog');
            dialog.className = 'sb-reply-dialog';
            dialog.setAttribute('aria-labelledby', 'sb-reply-dialog-title');
            dialog.setAttribute('aria-describedby', 'sb-reply-dialog-message');
            dialog.innerHTML = '<h2 id="sb-reply-dialog-title">重复回帖提醒</h2><p id="sb-reply-dialog-message"></p><div class="sb-reply-actions"><button type="button" data-cancel autofocus>取消</button><button type="button" data-continue>继续发送</button></div>';
            dialog.querySelector('p').textContent = message;
            let finished = false;
            const finish = accepted => {
                if (finished) return;
                finished = true;
                dialog.close();
                dialog.remove();
                if (previous?.isConnected) previous.focus({ preventScroll: true });
                resolve(accepted);
            };
            dialog.querySelector('[data-cancel]').onclick = () => finish(false);
            dialog.querySelector('[data-continue]').onclick = () => finish(true);
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
            dialog.addEventListener('close', () => finish(false));
            document.body.appendChild(dialog);
            dialog.showModal();
            dialog.querySelector('[data-cancel]').focus();
        });
    }
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
            if (message && !await replyGuardConfirm(message)) return;
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

})();

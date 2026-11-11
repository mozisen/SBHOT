const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync('shaobing-hot.user.js', 'utf8');
const tick = () => new Promise(r => setTimeout(r, 30));
const row = (floor, uid, content = '', klass = 'post-item') => `<${klass === 'floor-box-item' ? 'div' : 'li'} class="${klass}" data-reply-no="${floor}" id="post-${100 + floor}"><div class="post-head"><a class="post-author" href="/u/${uid}/">User${uid}</a></div><div class="${klass === 'floor-box-item' ? 'floor-box-body' : 'post-content'}">${content}</div></${klass === 'floor-box-item' ? 'div' : 'li'}>`;
const html = (rows = '', options = {}) => `<div class="top"><a class="nav-mine" href="/u/${options.uid || 2}/">我的</a></div><li id="post-42"><a class="post-author" href="/u/1/">楼主</a></li><section id="replies">${rows}${options.pager || ''}</section><div id="reply"><form method="post" action="/t/42/reply/"><textarea id="reply-body" name="body">保留的草稿</textarea><input name="reply_to" value=""><button type="submit" name="send" value="1">发送</button></form></div>`;
function setup(t, content, options = {}) {
    const dom = new JSDOM(options.current || content, { url: 'https://sb.sb/t/42/', runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window, prompts = [], requests = [], sends = [];
    w.GM_addStyle = () => {};
    w.GM_xmlhttpRequest = o => o.onerror();
    w.confirm = message => { prompts.push(message); return options.accept ?? false; };
    w.fetch = async (url, init) => {
        requests.push({ url, init });
        const body = options.fetcher ? await options.fetcher(url) : content;
        return { ok: true, url, text: async () => body };
    };
    w.eval(script);
    const form = w.document.querySelector('form'), button = form.querySelector('button');
    form.addEventListener('submit', e => { e.preventDefault(); sends.push(e.submitter); });
    return { w, form, button, prompts, requests, sends, send: () => form.requestSubmit(button) };
}
test('重复回复取消保留草稿；核对只发同源 GET', async t => {
    const s = setup(t, html(row(1, 2))); s.send(); await tick();
    assert.match(s.prompts[0], /尚未直接回复你/); assert.equal(s.sends.length, 0);
    assert.equal(s.form.elements.body.value, '保留的草稿');
    assert.equal(s.requests.length, 1); assert.equal(s.requests[0].url, 'https://sb.sb/t/42/');
    assert.equal(s.requests[0].init.credentials, 'same-origin'); assert.equal(s.requests[0].init.method, undefined);
    assert.equal(s.form.querySelector('[role=status]'), null);
});
test('继续只交给原生发送一次，保留 submitter，下一次重新核对', async t => {
    const s = setup(t, html(row(1, 2)), { accept: true });
    s.send(); s.send(); await tick();
    assert.equal(s.prompts.length, 1); assert.deepEqual(s.sends, [s.button]);
    s.send(); await tick(); assert.equal(s.prompts.length, 2); assert.equal(s.sends.length, 2);
});
test('首次回复或本人为楼主正常发送', async t => {
    for (const content of [html(row(1, 3)), html(row(1, 1), { uid: 1 })]) {
        const s = setup(t, content); s.send(); await tick();
        assert.equal(s.prompts.length, 0); assert.equal(s.sends.length, 1);
    }
});
test('楼主明确引用本人楼层、reply_id或@链接后不提醒', async t => {
    for (const link of ['<a href="/t/42/?reply=1">@User2 #1</a>', '<a href="/t/42/?reply_id=101">#1</a>', '<a href="/u/2/">@User2</a>']) {
        const s = setup(t, html(row(1, 2) + row(2, 1, link))); s.send(); await tick();
        assert.equal(s.prompts.length, 0); assert.equal(s.sends.length, 1);
    }
});
test('回复别人、引用旧正文、外站同名楼层、早于本人最近发言均继续提醒', async t => {
    for (const content of [
        row(1, 2) + row(2, 1, '<a href="/u/3/">@User3</a>'),
        row(1, 2) + row(2, 1, '<blockquote><a href="/t/42/?reply=1">#1</a></blockquote>'),
        row(1, 2) + row(2, 1, '<a href="https://evil.example/t/42/?reply=1">#1</a>'),
        row(1, 2) + row(2, 1, '<a href="/u/2/">@User2</a>') + row(3, 2),
        row(1, 2) + row(2, 1, '<a href="/t/43/?reply=1">#1</a>')
    ]) {
        const s = setup(t, html(content)); s.send(); await tick(); assert.match(s.prompts[0], /尚未直接回复你/);
    }
});
test('楼中楼省略目标默认回复外层本人；指定他人不算', async t => {
    for (const [target, warn] of [['', false], ['<span class="floor-box-to"><a href="/u/2/">User2</a></span>', false], ['<span class="floor-box-to"><a href="/u/3/">User3</a></span>', true]]) {
        const parent = row(1, 2).replace('</li>', `<div class="floor-box">${row(2, 1, target, 'floor-box-item')}</div></li>`);
        const s = setup(t, html(parent)); s.send(); await tick(); assert.equal(s.prompts.length, warn ? 1 : 0);
    }
});
test('别人的嵌套回复不会冒充外层楼主回复', async t => {
    const outer = row(2, 1).replace('</li>', `<div class="floor-box">${row(3, 3, '<a href="/t/42/?reply=1">#1</a>', 'floor-box-item')}</div></li>`);
    const s = setup(t, html(row(1, 2) + outer)); s.send(); await tick(); assert.match(s.prompts[0], /尚未直接回复你/);
});
test('核对分页中的本人回复和楼主回应，不依赖当前页', async t => {
    const first = html(row(1, 2), { pager: '<nav class="pagination"><a href="/t/42/page/2/">2</a></nav>' });
    const second = html(row(2, 1, '<a href="/t/42/?reply=1">#1</a>'));
    const s = setup(t, first, { current: second, fetcher: url => url.endsWith('/page/2/') ? second : first });
    s.send(); await tick(); assert.equal(s.requests.length, 2); assert.equal(s.prompts.length, 0); assert.equal(s.sends.length, 1);
});
test('网络失败、账号改变、分页超限均明确无法核实，默认可取消', async t => {
    for (const fetcher of [() => { throw Error('offline'); }, () => html(row(1, 2), { uid: 3 }),
        url => { const page = Number(url.match(/page\/(\d+)/)?.[1] || 1); return html(row(page, 2), { pager: `<nav class="pagination"><a href="/t/42/page/${page + 1}/">下一页</a></nav>` }); }]) {
        const s = setup(t, html(row(1, 2)), { fetcher }); s.send(); await tick();
        assert.match(s.prompts[0], /无法完整核实/); assert.equal(s.sends.length, 0); assert.ok(s.requests.length <= 10);
    }
});
test('异步核对期间改草稿、切账号或离开页面不继续发送', async t => {
    for (const mutate of [s => { s.form.elements.body.value = '新草稿'; }, s => { s.form.dispatchEvent(new s.w.Event('input', { bubbles: true })); }, s => { s.w.document.querySelector('.nav-mine').href = '/u/3/'; }, s => { s.w.history.replaceState(null, '', '/t/43/'); }]) {
        let resolve; const content = html(row(1, 2));
        const s = setup(t, content, { accept: true, fetcher: () => new Promise(r => { resolve = r; }) });
        s.send(); mutate(s); resolve(content); await tick(); assert.equal(s.prompts.length, 0); assert.equal(s.sends.length, 0);
    }
});
test('requestSubmit 无按钮的键盘路径同样拦截；其他表单不受影响', async t => {
    const s = setup(t, html(row(1, 2))); s.form.requestSubmit(); await tick(); assert.equal(s.prompts.length, 1);
    const other = s.w.document.createElement('form'); s.w.document.body.append(other);
    let sent = false; other.addEventListener('submit', e => { e.preventDefault(); sent = true; }); other.requestSubmit(); assert.equal(sent, true);
});
test('失败时用户可以明确选择继续；取消后再次核对可恢复', async t => {
    let fail = true;
    const s = setup(t, html(row(1, 2)), { accept: true, fetcher: () => {
        if (fail) throw Error('offline');
        return html(row(1, 2) + row(2, 1, '<a href="/u/2/">@User2</a>'));
    } });
    s.send(); await tick(); assert.match(s.prompts[0], /无法完整核实/); assert.equal(s.sends.length, 1);
    fail = false; s.send(); await tick(); assert.equal(s.prompts.length, 1); assert.equal(s.sends.length, 2);
});
test('隐藏或缺失的回复不能被当成已完整核对', async t => {
    const content = html(row(1, 2)) + '<div class="post-content-stats"><span>10</span><span>5</span></div>';
    const s = setup(t, content); s.send(); await tick(); assert.match(s.prompts[0], /无法完整核实/);
});
test('分页只能来自当前帖，外站和其他帖不会被请求', async t => {
    for (const href of ['https://evil.example/t/42/page/2/', '/t/43/page/2/']) {
        const s = setup(t, html(row(1, 2), { pager: `<nav class="pagination"><a href="${href}">2</a></nav>` }));
        s.send(); await tick(); assert.equal(s.requests.length, 1); assert.match(s.prompts[0], /无法完整核实/);
    }
});

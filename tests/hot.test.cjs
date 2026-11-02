const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync('shaobing-hot.user.js', 'utf8');
const fixture = fs.readFileSync('tests/fixtures/top.html', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const response = (body = fixture, path = '/pages/top/') => ({ ok: true, url: `https://sb.sb${path}`, text: async () => body });
function setup(t, fetcher, markup = '<aside class="sidebar"><div class="user-card"></div><div class="quick-card"></div></aside>', beforeRun = () => {}) {
    const dom = new JSDOM(markup, { url: 'https://sb.sb/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const calls = [];
    w.GM_addStyle = css => { const style = w.document.createElement('style'); style.textContent = css; w.document.head.append(style); };
    w.fetch = async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : response(fixture, url); };
    beforeRun(w);
    w.eval(script);
    t.after(() => w.close());
    return { w, calls, q: selector => w.document.querySelector(selector), all: selector => [...w.document.querySelectorAll(selector)] };
}
test('真实官方页面：回复榜顺序、数量、同源链接、前十条与展开收起', async t => {
    const s = setup(t); await tick();
    assert.equal(s.all('#sb-hot-panel').length, 1);
    assert.equal(s.q('.user-card').nextElementSibling.id, 'sb-hot-panel');
    assert.equal(s.all('.sb-hot-item').length, 20);
    assert.equal(s.all('.sb-hot-item:not([hidden])').length, 10);
    assert.equal(s.q('.sb-hot-link').getAttribute('href'), '/t/15643/');
    assert.equal(s.q('.sb-hot-count').textContent, '83');
    s.q('.sb-hot-toggle').click(); assert.equal(s.all('.sb-hot-item:not([hidden])').length, 20);
    s.q('.sb-hot-toggle').click(); assert.equal(s.all('.sb-hot-item:not([hidden])').length, 10);
    assert.equal(s.calls[0].options.credentials, 'same-origin');
    assert.equal(s.q('#sb-hot-panel').getAttribute('aria-busy'), 'false');
});
test('浏览/回复复用缓存，周期对应正确 URL，手动刷新绕过缓存', async t => {
    const s = setup(t); await tick();
    s.q('[data-metric="views"]').click(); await tick();
    assert.equal(s.calls.length, 1);
    assert.equal(s.q('[data-metric="views"]').getAttribute('aria-pressed'), 'true');
    s.q('[data-period="1"]').click(); await tick();
    assert.equal(s.calls.at(-1).url, '/pages/top/30d/');
    s.q('[data-period="2"]').click(); await tick();
    assert.equal(s.calls.at(-1).url, '/pages/top/all/');
    s.q('.sb-hot-refresh').click(); await tick(); assert.equal(s.calls.length, 4);
});
test('快速跨周期切换：旧请求晚返回也不能覆盖当前榜', async t => {
    let release;
    const s = setup(t, url => url === '/pages/top/' ? new Promise(resolve => { release = resolve; })
        : response(fixture.replaceAll('万圣节红包来了', '月榜主题'), url));
    s.q('[data-period="1"]').click(); await tick();
    assert.equal(s.q('.sb-hot-title').textContent, '月榜主题');
    release(response()); await tick();
    assert.equal(s.q('.sb-hot-title').textContent, '月榜主题');
});
test('同周期加载中切换排序不会重复请求或串榜', async t => {
    let release;
    const s = setup(t, () => new Promise(resolve => { release = resolve; }));
    s.q('[data-metric="views"]').click(); release(response()); await tick();
    assert.equal(s.calls.length, 1);
    assert.match(s.q('.sb-hot-link').title, /浏览/);
});
test('错误显示、刷新重试及失败保留旧数据', async t => {
    let fail = true;
    const s = setup(t, () => { if (fail) throw new Error('offline'); return response(); });
    await tick(); assert.match(s.q('.sb-hot-status').textContent, /获取失败/);
    assert.equal(s.q('.sb-hot-refresh').disabled, false);
    fail = false; s.q('.sb-hot-refresh').click(); await tick(); assert.equal(s.all('.sb-hot-item').length, 20);
    fail = true; s.q('.sb-hot-refresh').click(); await tick();
    assert.match(s.q('.sb-hot-status').textContent, /上次数据/); assert.equal(s.all('.sb-hot-item').length, 20);
});
test('HTML 注入与外站、javascript 链接被隔离，重复主题去重', async t => {
    const doc = new JSDOM(fixture).window.document;
    const board = doc.querySelectorAll('.top-board')[1];
    const first = board.querySelector('.top-thread-title');
    first.textContent = '<img src=x onerror=alert(1)>';
    board.querySelector('ol').append(board.querySelector('li').cloneNode(true));
    const links = board.querySelectorAll('.top-thread-title');
    links[1].href = 'https://evil.example/t/1/'; links[2].href = 'javascript:alert(1)';
    const s = setup(t, () => response(doc.documentElement.outerHTML)); await tick();
    assert.equal(s.q('.sb-hot-title').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(s.q('#sb-hot-panel img'), null);
    assert.equal(s.all('.sb-hot-item').length, 18);
    assert.ok(s.all('.sb-hot-link').every(a => a.origin === 'https://sb.sb'));
});
test('合法空榜和页面结构变化分别处理', async t => {
    const doc = new JSDOM(fixture).window.document;
    doc.querySelectorAll('.top-row').forEach(row => row.remove());
    const s = setup(t, () => response(doc.documentElement.outerHTML)); await tick();
    assert.match(s.q('.sb-hot-message').textContent, /暂无/); assert.equal(s.q('.sb-hot-toggle').hidden, true);
    const bad = setup(t, () => response('<h1>请登录</h1>')); await tick();
    assert.match(bad.q('.sb-hot-status').textContent, /获取失败/);
});
test('HTTP 错误和重定向均不能当作成功榜单', async t => {
    for (const result of [{ ...response(), ok: false, status: 503 }, response(fixture, '/login/')]) {
        const s = setup(t, () => result); await tick(); assert.match(s.q('.sb-hot-status').textContent, /获取失败/);
    }
});
test('超时会终止请求并恢复刷新按钮', async t => {
    let signal;
    const s = setup(t, (url, options) => new Promise((resolve, reject) => {
        signal = options.signal;
        options.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
    }), undefined, w => {
        const original = w.setTimeout.bind(w);
        w.setTimeout = (callback, delay) => original(callback, delay === 15000 ? 1 : delay);
    });
    await tick(); assert.equal(signal.aborted, true);
    assert.match(s.q('.sb-hot-status').title, /超时/); assert.equal(s.q('.sb-hot-refresh').disabled, false);
});
test('隐藏页面暂停刷新，恢复可见仅刷新过期缓存', async t => {
    let now = Date.now();
    let visible = true;
    let interval;
    const s = setup(t, null, undefined, w => {
        w.Date.now = () => now;
        Object.defineProperty(w.document, 'hidden', { get: () => !visible });
        w.setInterval = (fn, delay) => { if (delay === 15 * 60 * 1000) interval = fn; };
    });
    await tick(); now += 16 * 60 * 1000; visible = false; interval(); await tick();
    assert.equal(s.calls.length, 1);
    visible = true; s.w.document.dispatchEvent(new s.w.Event('visibilitychange')); await tick();
    assert.equal(s.calls.length, 2); interval(); await tick(); assert.equal(s.calls.length, 2);
});
test('无侧栏不发请求，异步侧栏可挂载且不重复', async t => {
    const s = setup(t, null, '<main></main>'); await tick(); assert.equal(s.calls.length, 0);
    const aside = s.w.document.createElement('aside'); aside.className = 'sidebar'; s.w.document.body.append(aside);
    await tick(); assert.equal(s.calls.length, 1); assert.equal(s.all('#sb-hot-panel').length, 1);
    aside.append(s.w.document.createElement('div')); await tick(); assert.equal(s.all('#sb-hot-panel').length, 1);
});

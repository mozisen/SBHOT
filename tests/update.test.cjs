const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync('shaobing-hot.user.js', 'utf8');
const meta = fs.readFileSync('shaobing-hot.meta.js', 'utf8');
const HOUR = 3600000;
function setup(t, store = {}, start = 1800000000000) {
    const dom = new JSDOM('<aside class="sidebar"></aside>', { url: 'https://sb.sb/', runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window, requests = [], timers = [], menus = [];
    let now = start;
    w.Date.now = () => now;
    w.GM_addStyle = () => {};
    w.GM_getValue = (key, fallback) => store[key] ?? fallback;
    w.GM_setValue = (key, value) => { store[key] = value; };
    w.GM_xmlhttpRequest = options => { requests.push(options); };
    w.GM_registerMenuCommand = (name, callback) => menus.push(callback);
    w.fetch = async () => { throw new Error('ranking offline'); };
    w.setInterval = (fn, ms) => timers.push({ fn, ms });
    w.eval(script);
    return { requests, store, menus, w, advance: ms => { now += ms; },
        poll: () => timers.find(timer => timer.ms === 60000).fn(),
        finish: (version, overrides = {}) => requests.at(-1).onload({ status: 200, responseText: meta.replace('@version      1.1.0', `@version      ${version}`), ...overrides }) };
}
test('发布元数据、源代码和 package 版本一致，固定 GitHub 更新路径', () => {
    assert.equal(meta.trim(), script.match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/)[0]);
    assert.equal(JSON.parse(fs.readFileSync('package.json')).version, '1.1.0');
    assert.match(script, /const VERSION = '1\.1\.0'/);
    assert.match(meta, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/mozisen\/SBHOT\/main\/shaobing-hot\.meta\.js/);
    assert.match(meta, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/mozisen\/SBHOT\/main\/shaobing-hot\.user\.js/);
    assert.doesNotMatch(meta, /@connect\s+\*/);
});
test('首次检测、一小时节流、持久化跨刷新与进行中去重', t => {
    const store = {};
    const s = setup(t, store);
    assert.equal(s.requests.length, 1); s.poll(); assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].anonymous, true);
    assert.equal(s.requests[0].timeout, 15000);
    s.finish('1.1.0'); s.advance(HOUR - 1); s.poll(); assert.equal(s.requests.length, 1);
    const reopened = setup(t, store); assert.equal(reopened.requests.length, 0);
    s.advance(1); s.poll(); assert.equal(s.requests.length, 2);
});
test('新版本显示固定安装入口，不执行远程代码或自动打开标签', t => {
    const s = setup(t); s.finish('1.10.0');
    const link = s.w.document.querySelector('.sb-hot-update a');
    assert.match(link.textContent, /1\.10\.0/);
    assert.equal(link.href, 'https://raw.githubusercontent.com/mozisen/SBHOT/main/shaobing-hot.user.js');
    assert.match(link.parentElement.title, /Tampermonkey/);
    assert.doesNotMatch(script, /\beval\s*\(|new Function\s*\(/);
});
test('同版本、旧版本不显示安装入口，按数字比较版本', t => {
    for (const version of ['1.1.0', '1.0.99', '0.99.99']) {
        const s = setup(t); s.finish(version);
        assert.equal(s.w.document.querySelector('.sb-hot-update a'), null);
    }
});
test('错误状态、错误脚本身份、恶意重定向不保存新版', t => {
    for (const overrides of [
        { status: 500 }, { responseText: '<html>error</html>' },
        { responseText: meta.replace('烧饼论坛热榜', '其他脚本') },
        { finalUrl: 'https://evil.example/script.meta.js' },
        { responseText: meta.replace('1.1.0', '1.1.0-beta') }
    ]) {
        const s = setup(t); s.finish('2.0.0', overrides);
        assert.equal(s.store['sb-hot-update-v1'].latest, undefined);
        assert.match(s.w.document.querySelector('.sb-hot-update').textContent, /失败/);
    }
});
test('请求超时可用菜单立即重试，自动重试仍按一小时节流', t => {
    const s = setup(t); s.requests[0].ontimeout();
    assert.match(s.w.document.querySelector('.sb-hot-update').textContent, /超时/);
    s.poll(); assert.equal(s.requests.length, 1);
    s.menus[0](); assert.equal(s.requests.length, 2); s.finish('1.1.0');
    assert.match(s.w.document.querySelector('.sb-hot-update').textContent, /已检查/);
});
test('时钟回拨不会永久禁止版本检查', t => {
    const s = setup(t, { 'sb-hot-update-v1': { lastAttempt: 1900000000000 } });
    assert.equal(s.requests.length, 1);
});

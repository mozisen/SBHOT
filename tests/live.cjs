// Explicit opt-in production read-only smoke test: node tests/live.cjs
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.route('https://sb.sb/', route => route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><style>.sidebar{width:280px;margin:20px}</style><aside class="sidebar"><div class="user-card"></div></aside>' }));
        await page.goto('https://sb.sb/');
        await page.evaluate(() => {
            const values = {};
            window.GM_getValue = (k, d) => values[k] ?? d;
            window.GM_setValue = (k, v) => { values[k] = v; };
            window.GM_registerMenuCommand = () => {};
            window.GM_addStyle = css => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); };
            window.GM_xmlhttpRequest = options => fetch(options.url, { credentials: 'omit' }).then(async r => options.onload({ status: r.status, finalUrl: r.url, responseText: await r.text() })).catch(() => options.onerror());
        });
        await page.addScriptTag({ path: 'shaobing-hot.user.js' });
        for (let i = 0; i < 4; i++) {
            await page.locator(`[data-period="${i}"]`).click();
            await page.waitForFunction(() => document.querySelector('#sb-hot-panel').getAttribute('aria-busy') === 'false');
            assert.doesNotMatch(await page.locator('.sb-hot-status').textContent(), /失败/);
            assert.ok(await page.locator('.sb-hot-data-note').textContent());
        }
        await page.waitForFunction(() => document.querySelector('.sb-hot-update').textContent.includes('已检查新版'));
        fs.mkdirSync('artifacts', { recursive: true });
        await page.locator('#sb-hot-panel').screenshot({ path: 'artifacts/live-warming.png' });
        const meta = await page.request.get('https://sbhot.voee.de/shaobing-hot.meta.js');
        assert.equal(meta.status(), 200);
        assert.equal((await meta.text()).trim(), fs.readFileSync('shaobing-hot.meta.js', 'utf8').trim());
        const status = await page.request.get('https://sbhot.voee.de/api/status');
        assert.equal(status.status(), 200);
        console.log('Production status:', await status.text());
        assert.deepEqual(errors, []);
        console.log('PASS: live HTTPS four-period client integration and hourly-update endpoint.');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

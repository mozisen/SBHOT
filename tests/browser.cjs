const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const fixture = JSON.parse(fs.readFileSync('tests/fixtures/rankings.json', 'utf8'));
        const home = fs.existsSync('sb-home.tmp.html') ? fs.readFileSync('sb-home.tmp.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            : '<html><meta charset="utf-8"><style>.sidebar{width:300px;margin:20px}</style><aside class="sidebar"><div class="user-card">烧饼论坛</div></aside></html>';
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: home });
            if (url.hostname === 'sbhot.voee.de' && url.pathname.startsWith('/api/rankings/')) {
                return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'https://sb.sb' }, body: JSON.stringify({ ...fixture, period: url.pathname.split('/').at(-1) }) });
            }
            if (url.pathname.includes('/assets/index.') && url.pathname.endsWith('.css') && fs.existsSync('sb-style.tmp.css')) {
                return route.fulfill({ contentType: 'text/css', body: fs.readFileSync('sb-style.tmp.css', 'utf8') });
            }
            return route.abort();
        });
        await page.goto('https://sb.sb/');
        await page.evaluate(() => {
            window.GM_addStyle = css => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); };
            window.GM_xmlhttpRequest = options => fetch(options.url).then(async r => options.onload({ status: r.status, finalUrl: r.url, responseText: await r.text() })).catch(() => options.onerror());
        });
        await page.addScriptTag({ path: 'shaobing-hot.user.js' });
        await page.locator('.sb-hot-item').first().waitFor();
        assert.equal(await page.locator('.sb-hot-data-note, .sb-hot-update, .sb-hot-note').count(), 0);
        assert.equal(await page.locator('.sb-hot-logo').count(), 1);
        assert.equal((await page.locator('.sb-hot-logo').boundingBox()).width, 26);
        assert.equal(await page.locator('#sb-hot-panel > :last-child').getAttribute('class'), 'sb-hot-footer');
        assert.ok((await page.locator('[data-period="0"]').boundingBox()).height <= 46, '周期按钮不能换行');
        assert.equal(await page.locator('.sb-hot-item:visible').count(), 10);
        await page.locator('.sb-hot-toggle').click();
        assert.equal(await page.locator('.sb-hot-item:visible').count(), 20);
        await page.locator('.sb-hot-toggle').click();
        for (const period of [1, 2, 3, 0]) {
            await page.locator(`[data-period="${period}"]`).click();
            await page.waitForFunction(() => document.querySelector('#sb-hot-panel').getAttribute('aria-busy') === 'false');
            assert.equal(await page.locator('.sb-hot-item').count(), 20);
        }
        await page.locator('[data-metric="views"]').click();
        await page.waitForFunction(() => document.querySelector('#sb-hot-panel').getAttribute('aria-busy') === 'false');
        assert.match(await page.locator('.sb-hot-link').first().getAttribute('title'), /浏览/);
        await page.locator('[data-metric="replies"]').focus(); await page.keyboard.press('Enter');
        fs.mkdirSync('artifacts', { recursive: true });
        await page.locator('#sb-hot-panel').screenshot({ path: 'artifacts/hot-light.png' });
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        await page.locator('#sb-hot-panel').screenshot({ path: 'artifacts/hot-dark.png' });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        assert.deepEqual(errors, []);
        console.log('PASS: Chromium 四周期 API、展开/收起、双榜、键盘、明暗截图、窄屏无溢出。');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

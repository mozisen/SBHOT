// Offline browser verification: never submits a real forum reply.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const html = `<meta charset="utf-8"><div class="top"><a class="nav-mine" href="/u/2/">我的</a></div>
          <li id="post-42"><a class="post-author" href="/u/1/">楼主</a></li>
          <div id="replies"><li class="post-item" id="post-101" data-reply-no="1"><a class="post-author" href="/u/2/">本人</a><div class="post-content">已有回复</div></li></div>
          <div id="reply"><form class="ajax-reply-form"><textarea id="reply-body" name="body" required>草稿</textarea><button type="submit">发送</button></form></div>`;
        const errors = [], requests = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => {
            requests.push(route.request().method());
            return route.fulfill({ contentType: 'text/html', body: html });
        });
        await page.goto('https://sb.sb/t/42/');
        await page.evaluate(() => {
            window.GM_addStyle = () => {};
            window.GM_xmlhttpRequest = o => o.onerror();
            window.sends = 0;
            // Register the forum's bubbling handler before the userscript, as on the real page.
            document.addEventListener('submit', e => { e.preventDefault(); window.sends++; });
            document.querySelector('textarea').addEventListener('keydown', e => {
                if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); e.target.form.requestSubmit(); }
            });
        });
        await page.addScriptTag({ content: fs.readFileSync('shaobing-hot.user.js', 'utf8') });
        let dialogs = 0;
        page.on('dialog', async dialog => {
            dialogs++;
            assert.match(dialog.message(), /尚未直接回复你/);
            if (dialogs === 1) await dialog.dismiss(); else await dialog.accept();
        });
        await page.getByRole('button', { name: '发送' }).click();
        await page.waitForFunction(() => !document.querySelector('[role=status]'));
        assert.equal(dialogs, 1);
        assert.equal(await page.evaluate(() => window.sends), 0);
        assert.equal(await page.locator('textarea').inputValue(), '草稿');
        await page.locator('textarea').press('Control+Enter');
        await page.waitForFunction(() => window.sends === 1);
        assert.equal(dialogs, 2);
        assert.deepEqual(errors, []);
        assert.ok(requests.every(method => method === 'GET'));
        console.log('Reply browser checks passed: cancel, draft retention, keyboard confirm, exactly one native submission.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

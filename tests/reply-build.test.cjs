const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const read = path => fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
test('independent 1.01 release identity, update URLs and shared module match', () => {
    const source = read('shaobing-reply-reminder.user.js');
    assert.match(source, /@name\s+烧饼重复回帖提醒\n/);
    assert.match(source, /@version\s+1\.01\n/);
    assert.match(source, /@updateURL\s+https:\/\/sbhot.voee.de\/shaobing-reply-reminder.meta.js/);
    assert.match(source, /@downloadURL\s+https:\/\/sbhot.voee.de\/shaobing-reply-reminder.user.js/);
    assert.doesNotMatch(source, /\/api\/rankings|GM_xmlhttpRequest|window\.confirm/);
    const module = read('scripts/reply-guard.js').trimEnd();
    for (const name of ['shaobing-hot', 'shaobing-reply-reminder']) {
        const text = read(name + '.user.js');
        assert.equal(text.split('// BEGIN SHARED REPLY GUARD\n')[1].split('\n// END SHARED REPLY GUARD')[0], module);
        assert.equal(read(name + '.meta.js').trim(), text.split('// ==/UserScript==')[0] + '// ==/UserScript==');
    }
});

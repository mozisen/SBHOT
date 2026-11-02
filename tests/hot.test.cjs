const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync('shaobing-hot.user.js', 'utf8');
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/rankings.json', 'utf8'));
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const response = (url, changes = {}) => ({ status: 200, finalUrl: url, responseText: JSON.stringify({ ...fixture, period: url.split('/').at(-1), ...changes }) });
function setup(t, fetcher, markup = '<aside class="sidebar"><div class="user-card"></div></aside>', before = () => {}) {
    const dom = new JSDOM(markup, { url: 'https://sb.sb/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, calls = [];
    w.GM_addStyle = () => {};
    w.GM_xmlhttpRequest = o => { calls.push(o); Promise.resolve().then(() => fetcher ? fetcher(o.url, o) : response(o.url)).then(data => { if (data) o.onload(data); }, () => o.onerror()); };
    before(w); w.eval(script); t.after(() => w.close());
    return { w, calls, q: selector => w.document.querySelector(selector), all: selector => [...w.document.querySelectorAll(selector)] };
}
test('four periods, top ten, expand, collapse, safe links', async t => {
    const s = setup(t); await tick();
    assert.deepEqual(s.all('[data-period]').map(x => x.textContent), ['实时', '24小时', '周榜', '30天榜']);
    assert.equal(s.q('.user-card').nextElementSibling.id, 'sb-hot-panel');
    assert.equal(s.all('.sb-hot-item:not([hidden])').length, 10);
    s.q('.sb-hot-toggle').click(); assert.equal(s.all('.sb-hot-item:not([hidden])').length, 20);
    s.q('.sb-hot-toggle').click(); assert.equal(s.all('.sb-hot-item:not([hidden])').length, 10);
    assert.equal(s.calls[0].anonymous, true);
    assert.equal(s.q('.sb-hot-link').getAttribute('href'), '/t/15643/');
});
test('metric cache, four endpoint mapping, forced refresh', async t => {
    const s = setup(t); await tick(); s.q('[data-metric="views"]').click(); await tick(); assert.equal(s.calls.length, 1);
    for (const [i, key] of ['daily','weekly','monthly'].entries()) { s.q(`[data-period="${i+1}"]`).click(); await tick(); assert.equal(s.calls.at(-1).url, `https://sbhot.voee.de/api/rankings/${key}`); }
    s.q('.sb-hot-refresh').click(); await tick(); assert.equal(s.calls.length, 5);
});
test('late earlier response cannot overwrite selected period', async t => {
    let release; const s = setup(t, url => url.endsWith('/realtime') ? new Promise(r => { release=r; }) : response(url));
    await tick(); s.q('[data-period="2"]').click(); await tick(); assert.match(s.q('.sb-hot-link').title,/周榜/);
    release(response('https://sbhot.voee.de/api/rankings/realtime')); await tick(); assert.match(s.q('.sb-hot-link').title,/周榜/);
});
test('pending metric switches deduplicate requests', async t => {
    let release; const s = setup(t, () => new Promise(r => { release=r; })); await tick();
    s.q('[data-metric="views"]').click(); release(response('https://sbhot.voee.de/api/rankings/realtime')); await tick();
    assert.equal(s.calls.length,1); assert.match(s.q('.sb-hot-link').title,/浏览观测增量/);
});
test('failure retry retains previous ranking', async t => {
    let fail=true; const s=setup(t,url=>{if(fail)throw Error('offline');return response(url);}); await tick(); assert.match(s.q('.sb-hot-status').textContent,/获取失败/);
    fail=false;s.q('.sb-hot-refresh').click();await tick();fail=true;s.q('.sb-hot-refresh').click();await tick();
    assert.match(s.q('.sb-hot-status').textContent,/上次数据/);assert.equal(s.all('.sb-hot-item').length,20);
});
test('baseline, warming, outage and stale explanations', async t => {
    for(const [changes, pattern] of [[{status:{baseline_complete:false,stale:true},boards:{views:[],replies:[]}},/建立全站基线/],[{warming_up:true,observed_seconds:7200},/已记录2小时/],[{coverage_gap:true},/采集中断/],[{status:{baseline_complete:true,stale:true}},/采集延迟/]]){
        const s=setup(t,url=>response(url,changes));await tick();assert.match(s.q('.sb-hot-data-note').textContent,pattern);
    }
});
test('reject unsafe topics, invalid JSON contract and wrong period', async t => {
    for(const changes of [{period:'weekly'},{boards:{}},{boards:{...fixture.boards,replies:[{href:'javascript:alert(1)',title:'x',count:1}]}}]){
        const s=setup(t,url=>response(url,changes));await tick();assert.match(s.q('.sb-hot-status').textContent,/获取失败/);
    }
});
test('titles remain text and empty ranking is valid', async t => {
    const s=setup(t,url=>response(url,{boards:{views:[],replies:[{href:'/t/1/',title:'<img src=x onerror=alert(1)>',count:1}]}}));await tick();
    assert.equal(s.q('#sb-hot-panel img'),null);assert.equal(s.q('.sb-hot-title').textContent,'<img src=x onerror=alert(1)>');
    s.q('[data-metric="views"]').click();await tick();assert.match(s.q('.sb-hot-message').textContent,/暂无/);
});
test('timeouts and redirects restore refresh control', async t => {
    const s=setup(t,(url,o)=>{o.ontimeout();});await tick();assert.match(s.q('.sb-hot-status').title,/超时/);assert.equal(s.q('.sb-hot-refresh').disabled,false);
    const bad=setup(t,url=>({...response(url),finalUrl:'https://evil.test/'}));await tick();assert.match(bad.q('.sb-hot-status').textContent,/获取失败/);
});
test('hidden pages skip ranking refresh and visible pages revalidate', async t => {
    let now=Date.now(),visible=true;const intervals=[];
    const s=setup(t,null,undefined,w=>{w.Date.now=()=>now;Object.defineProperty(w.document,'hidden',{get:()=>!visible});w.setInterval=fn=>intervals.push(fn);});
    await tick();now+=61000;visible=false;intervals[0]();await tick();assert.equal(s.calls.length,1);
    visible=true;s.w.document.dispatchEvent(new s.w.Event('visibilitychange'));await tick();assert.equal(s.calls.length,2);
});
test('deferred sidebar mounts once, absent sidebar sends no ranking request', async t => {
    const s=setup(t,null,'<main></main>');await tick();assert.equal(s.calls.length,0);
    const aside=s.w.document.createElement('aside');aside.className='sidebar';s.w.document.body.append(aside);await tick();aside.append(s.w.document.createElement('div'));await tick();
    assert.equal(s.calls.length,1);assert.equal(s.all('#sb-hot-panel').length,1);
});
test('official source uses sync label, upstream notes and stale-cache warning', async t => {
    const changes={source:'official',warming_up:false,metric_notes:{replies:'按最近24小时内新增回复数排名'},status:{baseline_complete:true,stale:false}};
    const s=setup(t,url=>response(url,changes));await tick();s.q('[data-period="1"]').click();await tick();
    assert.match(s.q('.sb-hot-data-note').textContent,/官方榜单/);
    assert.match(s.q('.sb-hot-status').textContent,/同步/);
    assert.match(s.q('.sb-hot-link').title,/官方统计/);
    assert.match(s.q('.sb-hot-link').title,/新增回复数排名/);
    assert.equal(s.q('.sb-hot-source').href,'https://sb.sb/pages/top/');
    const delayed=setup(t,url=>response(url,{...changes,status:{baseline_complete:true,stale:false,refresh_error:'offline'}}));await tick();
    assert.match(delayed.q('.sb-hot-data-note').textContent,/同步延迟/);
    assert.equal(delayed.all('.sb-hot-item').length,20);
});

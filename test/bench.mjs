/*
 * Banc de mesure : page lourde type EuropNet (800 chatteurs, 60 conversations, 400 messages)
 * avec activité continue (10 messages/s, lecteur qui bouge, changements de classes, bascules
 * « non lu »), pour vérifier que l'extension ne fait pas ramer le site.
 *
 *   node test/bench.mjs                 mesure l'extension de ce dépôt
 *   node test/bench.mjs none            mesure la page seule (référence)
 *   NOUNREAD=1 node test/bench.mjs      sans les bascules « non lu »
 *
 * Repère : « ScriptDuration » = temps passé dans les scripts (extension comprise) sur 6 s ;
 * il doit rester de l'ordre de 100 ms.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(join(execSync('npm root -g',{encoding:'utf8'}).trim(),'playwright'));

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(here, '..');   // dossier de l'extension, ou "none"
const DURATION = 6000;

const NAMES = Array.from({ length: 800 }, (_, i) => 'user' + (i * 7919 % 10007).toString(36) + '_' + (18 + i % 40));
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;display:flex;height:100vh;font:13px sans-serif}
.kiwi-statebrowser{width:220px;overflow:auto;background:#0f2c52;color:#dbeafe;padding:8px}
.kiwi-statebrowser-channel{padding:3px 0;display:flex;gap:6px}
.kiwi-messagelist{flex:1;overflow:auto;padding:8px}
.kiwi-messagelist-message{margin-bottom:6px}
.kiwi-messagelist-nick{font-weight:600;color:#2563eb}
.side{width:320px;display:flex;flex-direction:column;background:#eef2f7}
.scroller{flex:1;overflow:auto}
.row{display:flex;gap:10px;padding:2px 8px}.cell-username{width:150px;font-weight:600}.cell{width:40px}
</style></head><body>
<nav class="kiwi-statebrowser"><div id="player">No Station Selected</div><div id="clock">0</div>
 <div class="kiwi-statebrowser-channel"><span class="kiwi-statebrowser-channel-name">#BDSM</span></div>
 ${NAMES.slice(0, 60).map((n) => `<div class="kiwi-statebrowser-channel"><span class="kiwi-statebrowser-channel-name">${n}</span></div>`).join('')}
</nav>
<main class="kiwi-messagelist" id="messages">
 ${Array.from({ length: 400 }, (_, i) => `<div class="kiwi-messagelist-message"><span class="kiwi-messagelist-nick">${NAMES[(i * 13) % 800]}</span> <span>message ${i}</span></div>`).join('')}
</main>
<aside class="side"><div><input placeholder="Nick"></div><div class="scroller" id="chatters">
 ${NAMES.map((n, i) => `<div class="row"><span class="cell-username">${n}</span><span class="cell">${18 + i % 40}</span><span>Paris</span></div>`).join('')}
</div></aside></body></html>`;

const MOCK = `(()=>{const l=[];const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const d={tags:{},settings:{}};
for(let i=0;i<30;i++){const n='user'+(i*7919%10007).toString(36)+'_'+(18+i%40);d.tags[n.toLowerCase()]={nick:n,tag:['green','yellow','red'][i%3],note:'',updatedAt:1};}
globalThis.__entagStore=d;globalThis.browser={storage:{local:{async get(x){const o={};for(const k of Object.keys(x||d))o[k]=d[k]===undefined?x[k]:clone(d[k]);return o},async set(p){const c={};for(const [k,v] of Object.entries(p)){c[k]={newValue:v};d[k]=clone(v)}l.forEach(f=>f(c,'local'))}},onChanged:{addListener:f=>l.push(f)}},runtime:{onMessage:{addListener(){}}}}})();`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1300, height: 700 } });
await page.addInitScript(MOCK);
await page.route('http://bench.local/', (r) => r.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }));
await page.goto('http://bench.local/');
const ok = await page.evaluate(() => typeof globalThis.browser !== 'undefined');
if (!ok) throw new Error('mock browser absent');
if (dir !== 'none') {
  const files = ['src/content/content.css', 'src/common/store.js', 'src/common/alias.js', 'src/content/content.js'];
  for (const f of files) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf8');
    if (f.endsWith('.css')) await page.addStyleTag({ content }); else await page.addScriptTag({ content });
  }
}
if (process.env.NOUNREAD) await page.evaluate(() => { window.__noUnread = true; });
await page.waitForTimeout(1500);   // premier balayage
const ext = dir === 'none' ? 0 : await page.evaluate(() => document.querySelectorAll('.entag-nick').length);
console.log('pseudos décorés par l\'extension :', ext);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('Profiler.enable');
const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
await cdp.send('Profiler.start');

/* Activité simulée : chat (10 msg/s), lecteur (20 maj/s), churn de classes (50/s), bascule non-lu (5/s). */
await page.evaluate((DURATION) => new Promise((resolve) => {
  const msgs = document.getElementById('messages');
  const clock = document.getElementById('clock');
  const entries = Array.from(document.querySelectorAll('.kiwi-statebrowser-channel'));
  const rows = Array.from(document.querySelectorAll('#messages .kiwi-messagelist-message'));
  let n = 0;
  const t0 = performance.now();
  const timers = [];
  timers.push(setInterval(() => {
    const d = document.createElement('div');
    d.className = 'kiwi-messagelist-message';
    d.innerHTML = '<span class="kiwi-messagelist-nick">user' + (n % 50).toString(36) + '_20</span> <span>nouveau ' + n + '</span>';
    msgs.appendChild(d); msgs.firstChild.remove(); n += 1;
  }, 100));
  timers.push(setInterval(() => { clock.textContent = String(performance.now() | 0); }, 50));
  timers.push(setInterval(() => { rows[(Math.random() * rows.length) | 0].classList.toggle('hover'); }, 20));
  if (!window.__noUnread) timers.push(setInterval(() => {
    const e = entries[1 + ((Math.random() * (entries.length - 1)) | 0)];
    e.classList.toggle('kiwi-statebrowser-channel-unread');
  }, 200));
  setTimeout(() => { timers.forEach(clearInterval); resolve(); }, DURATION);
}), DURATION);

const { profile } = await cdp.send('Profiler.stop');
const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const d = (k) => ((m1[k] - m0[k]) * 1000).toFixed(0);

/* temps propre par fonction (profil échantillonné) */
const self = new Map();
const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const nd = byId.get(id);
  const key = nd.callFrame.functionName + ' (' + (nd.callFrame.url.split('/').pop() || 'native') + ':' + nd.callFrame.lineNumber + ')';
  self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
});
const top = [...self.entries()].filter(([k]) => !/^\(idle\)|^\(program\)|^\(root\)/.test(k)).sort((a, c) => c[1] - a[1]).slice(0, 8);

console.log(`\n== ${dir.split('/').pop()} ==`);
console.log(`ScriptDuration ${d('ScriptDuration')} ms | Layout ${d('LayoutDuration')} ms | RecalcStyle ${d('RecalcStyleDuration')} ms | Task ${d('TaskDuration')} ms (sur ${DURATION} ms)`);
top.forEach(([k, v]) => console.log('  ' + v.toFixed(0).padStart(5) + ' ms  ' + k));
await b.close();

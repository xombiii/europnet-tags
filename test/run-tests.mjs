/*
 * Tests d'intégration du content script.
 *
 * On charge test/fixture.html dans Chromium (Playwright), on simule l'API
 * WebExtension (browser.storage / browser.runtime), puis on injecte
 * src/common/store.js et src/content/content.js exactement comme Firefox le
 * ferait sur la page du tchat.
 *
 *   node --experimental-default-type=module test/run-tests.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/* Playwright peut être installé localement ou globalement. */
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(join(globalRoot, 'playwright'));
  }
}
const { chromium } = loadPlaywright();

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
};

const MOCK_API = `
(() => {
  const listeners = { storage: [], message: [] };
  const data = { tags: {}, settings: {} };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  globalThis.__entagStore = data;
  globalThis.browser = {
    storage: {
      local: {
        async get(defaults) {
          const out = {};
          for (const key of Object.keys(defaults || data)) {
            out[key] = data[key] === undefined ? defaults[key] : clone(data[key]);
          }
          return out;
        },
        async set(patch) {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
            data[key] = clone(value);
          }
          listeners.storage.forEach((fn) => fn(changes, 'local'));
        }
      },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendMessage: async (msg) => listeners.message.map((fn) => fn(msg))[0]
    }
  };
  globalThis.__entagSend = (msg) => listeners.message.map((fn) => fn(msg));
})();
`;

/* 0. Score d'alias (module pur, sans navigateur) ------------------------------ */
const aliasCtx = { };
aliasCtx.globalThis = aliasCtx;
vm.createContext(aliasCtx);
vm.runInContext(read('src/common/alias.js'), aliasCtx);
const EA = aliasCtx.ENAlias;
const sc = (a, b) => EA.score(a, b);

check('alias : « anais-24 » ~ « anais_24 » signalé',
  sc({ nick: 'anais-24' }, { nick: 'anais_24' }).score >= EA.THRESHOLD, sc({ nick: 'anais-24' }, { nick: 'anais_24' }));
check('alias : une lettre en plus + même nombre signalé',
  sc({ nick: 'anais-24' }, { nick: 'anaiss-24' }).score >= EA.THRESHOLD, sc({ nick: 'anais-24' }, { nick: 'anaiss-24' }));
check('alias : leet « m4itresse_75 » ~ « maitresse » signalé',
  sc({ nick: 'maitresse' }, { nick: 'm4itresse_75' }).score >= EA.THRESHOLD && EA.core('m4itresse_75') === 'maitresse');
check('alias : accents et casse ignorés (« Anaïs_24 » ~ « anais24 »)',
  sc({ nick: 'Anaïs_24' }, { nick: 'anais24' }).score >= EA.THRESHOLD);
check('alias : « Sophie_75 » ~ « Sophie_69 » seul : trop faible pour signaler',
  sc({ nick: 'Sophie_75' }, { nick: 'Sophie_69' }).score < EA.THRESHOLD, sc({ nick: 'Sophie_75' }, { nick: 'Sophie_69' }));
check('alias : même base + même ville + même âge = probable',
  sc({ nick: 'Sophie_75', city: 'Paris', age: 22 }, { nick: 'Sophie_69', city: 'paris', age: 22 }).level === 'probable');
check('alias : même âge + même ville SANS pseudo proche = rien',
  sc({ nick: 'Soraka', city: 'Paris', age: 22 }, { nick: 'Souestelle', city: 'Paris', age: 22 }).score === 0);
check('alias : même pseudo (casse différente) = même personne, pas un alias',
  sc({ nick: 'Louise_Stressee' }, { nick: 'louise_stressee' }).score === 0);
check('alias : noyau de moins de 4 lettres ignoré (« ana75017 »)',
  sc({ nick: 'ana75017' }, { nick: 'ana75018' }).score === 0);
check('alias : âge très différent = malus',
  sc({ nick: 'Cassandre_24', age: 24 }, { nick: 'Cassandre_24x', age: 45 }).score <
  sc({ nick: 'Cassandre_24', age: 24 }, { nick: 'Cassandre_24x', age: 24 }).score);
const cands = EA.findCandidates({ nick: 'anais-24', age: 24, city: 'paris' }, {
  'anais_24': { nick: 'anais_24', age: 24, city: 'Paris', last: 2 },
  'anaiss-24': { nick: 'anaiss-24', last: 1 },
  'leakitty': { nick: 'leakitty', age: 18, city: 'Rennes', last: 3 },
  'anais-24': { nick: 'anais-24', age: 24, city: 'paris', last: 4 }
}, (key) => key === 'anaiss-24');
check('alias : recherche dans l\'historique triée, sans le pseudo lui-même ni les écartés',
  cands.length === 1 && cands[0].nick === 'anais_24', cands.map((c) => c.nick));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(MOCK_API);
await page.goto(pathToFileURL(join(here, 'fixture.html')).href);
await page.addStyleTag({ content: read('src/content/content.css') });
await page.addScriptTag({ content: read('src/common/store.js') });
await page.addScriptTag({ content: read('src/common/alias.js') });
await page.addScriptTag({ content: read('src/content/content.js') });
await page.waitForTimeout(150);

/* 1. Extraction des pseudos ------------------------------------------------ */
const nicks = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-entag-nick]')).map((el) => el.dataset.entagNick));
check('pseudo « Bigbi ♂ » nettoyé', nicks.includes('Bigbi'), nicks);
check('préfixe de mode « @Maitresse » retiré', nicks.includes('Maitresse'), nicks);
check('préfixe de mode « %Althanea » retiré', nicks.includes('Althanea'), nicks);
check('pseudo à tirets « __TravSoum_75-44 » reconnu', nicks.includes('__TravSoum_75-44'), nicks);
check('salon « #BDSM » ignoré', !nicks.includes('BDSM'), nicks);

/* 2. Aucune pastille tant que rien n'est tagué ----------------------------- */
check('aucune pastille au départ', (await page.locator('.entag-badge').count()) === 0);

/* 3. Pose de tags → pastilles dans les 3 zones ----------------------------- */
await page.evaluate(() => browser.storage.local.set({
  tags: {
    bigbi: { nick: 'Bigbi', tag: 'green', note: 'sympa', updatedAt: Date.now() },
    cassandre0075: { nick: 'cassandre0075', tag: 'yellow', note: '', updatedAt: Date.now() },
    _laura: { nick: '_laura', tag: 'red', note: 'arnaque', updatedAt: Date.now() }
  }
}));
await page.waitForTimeout(250);

const zone = (sel, cls) => page.locator(sel + ' ' + cls).count();
check('pastille verte dans le salon (Bigbi)',
  (await zone('#messages', '.entag-badge--green')) === 1);
check('pastille jaune dans le salon (cassandre0075)',
  (await zone('#messages', '.entag-badge--yellow')) === 1);
check('pastille jaune dans la barre latérale (cassandre0075)',
  (await zone('.kiwi-statebrowser', '.entag-badge--yellow')) === 1);
check('pastille rouge dans la liste des membres (_laura)',
  (await zone('#nicklist', '.entag-badge--red')) === 1);
check('aucune pastille en double',
  (await page.locator('.entag-badge').count()) === 4,
  await page.locator('.entag-badge').count());

const placement = await page.evaluate(() => {
  const nick = document.querySelector('#nicklist .kiwi-nicklist-user-nick + .gender')
    ? Array.from(document.querySelectorAll('#nicklist .kiwi-nicklist-user-nick')).find((el) => el.dataset.entagNick === '_laura')
    : null;
  return nick ? nick.lastElementChild && nick.lastElementChild.classList.contains('entag-badge') : false;
});
check('pastille placée à la fin du pseudo', placement);

const tooltip = await page.getAttribute('#nicklist .entag-badge--red', 'title');
check('infobulle = pseudo + libellé + note', /_laura/.test(tooltip) && /éviter/i.test(tooltip) && /arnaque/.test(tooltip), tooltip);

/* 4. Message ajouté dynamiquement (MutationObserver) ----------------------- */
await page.evaluate(() => {
  const row = document.createElement('div');
  row.className = 'kiwi-messagelist-message';
  row.innerHTML = '<span class="kiwi-messagelist-nick">_laura <i class="gender">♀</i></span>' +
    '<div class="kiwi-messagelist-body">coucou</div>';
  document.getElementById('messages').appendChild(row);
});
await page.waitForTimeout(250);
check('nouveau message tagué automatiquement',
  (await zone('#messages', '.entag-badge--red')) === 1);

/* 4b. Flag « whisp » : conversation privée à gauche → flag dans la liste de droite */
const whisperFlags = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('.entag-whisper')).map((el) => ({
    nick: el.dataset.entagWhisperFor,
    zone: el.closest('#nicklist') ? 'nicklist'
      : el.closest('.kiwi-statebrowser') ? 'sidebar'
      : el.closest('#messages') ? 'messages' : 'other'
  })));

let flags = await whisperFlags();
check('flag whisp sur %Althanea (conversation privée ouverte) dans la liste des membres',
  flags.some((f) => f.nick === 'Althanea' && f.zone === 'nicklist'), flags);
check('un seul flag whisp au départ (ni à gauche, ni dans le salon)', flags.length === 1, flags);

/* Ouverture d'une conversation privée avec _laura (déjà taguée en rouge). */
await page.evaluate(() => {
  const row = document.createElement('div');
  row.className = 'kiwi-statebrowser-channel';
  row.innerHTML = '<span class="kiwi-statebrowser-channel-name">_laura</span>';
  document.querySelector('.kiwi-statebrowser').appendChild(row);
});
await page.waitForTimeout(400);
flags = await whisperFlags();
check('flag whisp ajouté sur _laura dès l\'ouverture de la conversation',
  flags.some((f) => f.nick === '_laura' && f.zone === 'nicklist'), flags);
check('aucun flag whisp dans la barre de gauche ni dans le salon',
  flags.every((f) => f.zone === 'nicklist'), flags);

const order = await page.evaluate(() => {
  const nick = Array.from(document.querySelectorAll('#nicklist .kiwi-nicklist-user-nick'))
    .find((el) => el.dataset.entagNick === '_laura');
  const kids = Array.from(nick.children).map((c) => c.className.split(' ')[0]);
  return kids;
});
check('ordre à la fin du pseudo : pastille puis flag whisp',
  order.join(',') === 'entag-badge,entag-whisper', order);

/* Fermeture de la conversation privée. */
await page.evaluate(() => {
  const names = Array.from(document.querySelectorAll('.kiwi-statebrowser-channel-name'));
  const row = names.find((el) => el.textContent.trim() === '_laura').closest('.kiwi-statebrowser-channel');
  row.remove();
});
await page.waitForTimeout(400);
flags = await whisperFlags();
check('flag whisp retiré à la fermeture de la conversation',
  !flags.some((f) => f.nick === '_laura') && flags.length === 1, flags);
check('la pastille de _laura reste en place',
  (await zone('#nicklist', '.entag-badge--red')) === 1);

/* Réglage : flag désactivable. */
await page.evaluate(() => browser.storage.local.set({ settings: { showWhisperFlag: false } }));
await page.waitForTimeout(300);
check('flag whisp masqué quand le réglage est coupé', (await whisperFlags()).length === 0);
await page.evaluate(() => browser.storage.local.set({ settings: {} }));
await page.waitForTimeout(300);
check('flag whisp de retour quand le réglage est réactivé', (await whisperFlags()).length === 1);

/* 4c. Filtre : masquer de la liste les pseudos en conversation privée -------- */
const rowHidden = (nick) => page.evaluate((n) => {
  const el = Array.from(document.querySelectorAll('#nicklist .kiwi-nicklist-user-nick'))
    .find((e) => e.dataset.entagNick === n);
  return getComputedStyle(el.closest('.kiwi-nicklist-user')).display === 'none';
}, nick);
const allNicks = ['Maitresse', 'Althanea', '_laura', '__TravSoum_75-44', 'coeur_de_dragon'];
const hiddenNow = async () => {
  const out = [];
  for (const n of allNicks) if (await rowHidden(n)) out.push(n);
  return out;
};
const chip = page.locator('.entag-filter');

check('bouton de filtre affiché avec le nombre de whisp (1)',
  (await chip.isVisible()) && /\(1\)/.test(await chip.textContent()), await chip.textContent());
const placed = await page.evaluate(() => {
  const c = document.querySelector('.entag-filter').getBoundingClientRect();
  const l = document.getElementById('nicklist').getBoundingClientRect();
  return c.left >= l.left - 1 && c.right <= l.right + 1 && c.top >= l.top && c.bottom <= l.bottom + 1;
});
check('bouton placé dans le cadre de la liste des membres', placed);
check('aucune ligne masquée tant que le filtre est coupé', (await hiddenNow()).length === 0, await hiddenNow());

await chip.click();
await page.waitForTimeout(300);
check('filtre actif : la ligne entière de %Althanea est masquée',
  JSON.stringify(await hiddenNow()) === JSON.stringify(['Althanea']), await hiddenNow());
check('filtre actif : la liste elle-même reste affichée',
  await page.evaluate(() => getComputedStyle(document.getElementById('nicklist')).display !== 'none'));
check('réglage enregistré (hideWhispered)',
  await page.evaluate(() => globalThis.__entagStore.settings.hideWhispered === true));
check('bouton en mode actif', /masqués \(1\)/.test(await chip.textContent()), await chip.textContent());

/* Ouverture / fermeture d'une conversation privée avec le filtre actif. */
await page.evaluate(() => {
  const row = document.createElement('div');
  row.className = 'kiwi-statebrowser-channel';
  row.innerHTML = '<span class="kiwi-statebrowser-channel-name">_laura</span>';
  document.querySelector('.kiwi-statebrowser').appendChild(row);
});
await page.waitForTimeout(400);
check('nouvelle conversation privée : _laura disparaît de la liste',
  JSON.stringify(await hiddenNow()) === JSON.stringify(['Althanea', '_laura']), await hiddenNow());
check('compteur du bouton mis à jour (2)', /\(2\)/.test(await chip.textContent()), await chip.textContent());

await page.evaluate(() => {
  const names = Array.from(document.querySelectorAll('.kiwi-statebrowser-channel-name'));
  names.find((el) => el.textContent.trim() === '_laura').closest('.kiwi-statebrowser-channel').remove();
});
await page.waitForTimeout(400);
check('conversation fermée : _laura réapparaît dans la liste',
  JSON.stringify(await hiddenNow()) === JSON.stringify(['Althanea']), await hiddenNow());

/* Désactivation depuis le bouton. */
await chip.click();
await page.waitForTimeout(300);
check('filtre coupé : toutes les lignes sont de nouveau visibles', (await hiddenNow()).length === 0, await hiddenNow());
check('bouton revenu à « Masquer »', /^Masquer/.test(await chip.textContent()), await chip.textContent());

/* Le réglage fonctionne aussi depuis la page d'options (stockage partagé). */
await page.evaluate(() => browser.storage.local.set({ settings: { hideWhispered: true } }));
await page.waitForTimeout(400);
check('filtre activé via les options', JSON.stringify(await hiddenNow()) === JSON.stringify(['Althanea']), await hiddenNow());
await page.evaluate(() => browser.storage.local.set({ settings: {} }));
await page.waitForTimeout(400);
check('filtre désactivé via les options', (await hiddenNow()).length === 0, await hiddenNow());

/* 5. Menu au clic droit ---------------------------------------------------- */
await page.locator('#nicklist .kiwi-nicklist-user-nick', { hasText: 'coeur_de_dragon' }).click({ button: 'right' });
await page.waitForTimeout(120);
check('menu ouvert au clic droit', await page.locator('.entag-menu:not([hidden])').isVisible());
check('menu titré avec le pseudo',
  (await page.locator('.entag-menu__nick').textContent()) === 'coeur_de_dragon');

await page.locator('.entag-menu__input').fill('à surveiller');
await page.locator('.entag-menu__item[data-tag="yellow"]').click();
await page.waitForTimeout(250);

const stored = await page.evaluate(() => globalThis.__entagStore.tags.coeur_de_dragon);
check('tag enregistré depuis le menu', stored && stored.tag === 'yellow', stored);
check('note enregistrée depuis le menu', stored && stored.note === 'à surveiller', stored);
check('pastille appliquée immédiatement',
  (await zone('#nicklist', '.entag-badge--yellow')) === 1);
check('menu refermé après le choix', await page.locator('.entag-menu').isHidden());

/* 6. Retrait d'un tag ------------------------------------------------------ */
await page.locator('#nicklist .kiwi-nicklist-user-nick', { hasText: 'coeur_de_dragon' }).click({ button: 'right' });
await page.locator('.entag-menu__item[data-action="clear"]').click();
await page.waitForTimeout(250);
check('pastille retirée après suppression du tag',
  (await zone('#nicklist', '.entag-badge--yellow')) === 0);

/* 7. Mode pipette ---------------------------------------------------------- */
await page.evaluate(() => globalThis.__entagSend({ type: 'entag:pick' }));
await page.waitForTimeout(120);
check('mode pipette actif', await page.evaluate(() => document.documentElement.classList.contains('entag-picking')));
await page.locator('.kiwi-messagelist-time').first().click();
await page.waitForTimeout(200);
check('mode pipette désactivé après le clic',
  !(await page.evaluate(() => document.documentElement.classList.contains('entag-picking'))));

/* 8. Onglet « Chatteurs » : liste à colonnes, classes différentes de Kiwi ----- */
await page.goto(pathToFileURL(join(here, 'fixture-chatteurs.html')).href);
await page.addStyleTag({ content: read('src/content/content.css') });
await page.addScriptTag({ content: read('src/common/store.js') });
await page.addScriptTag({ content: read('src/common/alias.js') });
await page.addScriptTag({ content: read('src/content/content.js') });
await page.waitForTimeout(400);

const chatterRows = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('#chatters .row')).map((row) => ({
    nick: row.querySelector('.cell-username').dataset.entagNick || row.querySelector('.cell-username').textContent.trim(),
    hidden: getComputedStyle(row).display === 'none'
  })));
const hiddenChatters = async () => (await chatterRows()).filter((r) => r.hidden).map((r) => r.nick);

const chip2 = page.locator('.entag-filter');
check('chatteurs : flag whisp sur Soraka, anais-24 et _petitebrune',
  (await page.locator('#chatters .entag-whisper').count()) === 3, await page.locator('#chatters .entag-whisper').count());
check('chatteurs : bouton de filtre visible avec le compteur (3)',
  (await chip2.isVisible()) && /\(3\)/.test(await chip2.textContent()), await chip2.textContent());
const placed2 = await page.evaluate(() => {
  const c = document.querySelector('.entag-filter').getBoundingClientRect();
  const l = document.querySelector('.side-panel').getBoundingClientRect();
  return c.left >= l.left - 1 && c.right <= l.right + 1 && c.top >= l.top && c.bottom <= l.bottom + 1;
});
check('chatteurs : bouton placé dans le panneau de droite', placed2);

await chip2.click();
await page.waitForTimeout(300);
check('chatteurs : les 3 lignes entières (pseudo + âge + ville) sont masquées',
  JSON.stringify(await hiddenChatters()) === JSON.stringify(['Soraka', 'anais-24', '_petitebrune']), await hiddenChatters());
check('chatteurs : les autres chatteurs restent visibles',
  (await chatterRows()).filter((r) => !r.hidden).length === 4);
check('chatteurs : les filtres (champ Nick, cases) ne sont pas masqués',
  await page.evaluate(() => getComputedStyle(document.getElementById('filter-input')).display !== 'none' &&
    getComputedStyle(document.querySelector('.filters')).display !== 'none'));
check('chatteurs : une fiche isolée (Soraka + bouton) n\'est pas masquée',
  await page.evaluate(() => getComputedStyle(document.getElementById('card')).display !== 'none'));
check('chatteurs : le bouton reste affiché quand tout est masqué',
  (await chip2.isVisible()) && /masqués \(3\)/.test(await chip2.textContent()), await chip2.textContent());

await chip2.click();
await page.waitForTimeout(300);
check('chatteurs : filtre coupé, toutes les lignes reviennent', (await hiddenChatters()).length === 0, await hiddenChatters());

/* 9. Alias des pseudos tagués (liste « Chatteurs » avec âge et ville) --------- */
await page.evaluate(() => browser.storage.local.set({
  tags: { 'anais-24': { nick: 'anais-24', tag: 'red', note: 'arnaque', updatedAt: Date.now() } }
}));
await page.waitForTimeout(300);

const addChatter = (nick, age, city) => page.evaluate(([n, a, c]) => {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<span class="cell-username"></span><span class="cell"></span><span class="cell-city"></span>';
  row.children[0].textContent = n;
  row.children[1].textContent = a;
  row.children[2].textContent = c;
  document.getElementById('chatters').appendChild(row);
}, [nick, age, city]);

const aliasMarkers = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('.entag-alias')).map((el) => ({
    nick: el.dataset.entagAliasFor, cls: el.className, title: el.title })));

await addChatter('anais_24', 24, 'Paris');
await addChatter('anaiss-25', 19, 'Lyon');
await page.waitForTimeout(500);
let markers = await aliasMarkers();
check('alias : « anais_24 » (même âge, même ville) reçoit un anneau rouge',
  markers.length === 1 && markers[0].nick === 'anais_24' && /entag-alias--red/.test(markers[0].cls), markers);
check('alias : l\'infobulle cite le pseudo tagué, le score et les raisons',
  /anais-24/.test(markers[0].title) && /probable/.test(markers[0].title) && /même ville/.test(markers[0].title), markers[0] && markers[0].title);
check('alias : « anaiss-25 » (âge très différent) et les autres pseudos ne sont pas signalés', markers.length === 1, markers);

/* Menu : bloc « alias » puis application du tag. */
await page.locator('#chatters .cell-username', { hasText: /^anais_24$/ }).click({ button: 'right' });
await page.waitForTimeout(150);
check('alias : le menu affiche le bloc « Alias probable de anais-24 »',
  (await page.locator('.entag-menu__alias').isVisible()) &&
  /Alias probable de anais-24/.test(await page.locator('.entag-menu__alias-text').textContent()));
await page.locator('[data-action="alias-apply"]').click();
await page.waitForTimeout(400);
const linked = await page.evaluate(() => globalThis.__entagStore.tags['anais_24']);
check('alias : le tag de anais-24 est appliqué et le lien enregistré',
  linked && linked.tag === 'red' && linked.aliasOf === 'anais-24' && /^Alias de anais-24 — arnaque/.test(linked.note), linked);
check('alias : l\'anneau laisse place à la pastille rouge',
  (await aliasMarkers()).length === 0 && (await page.locator('#chatters .entag-badge--red').count()) === 2);

/* « Ce n'est pas lui » : le candidat est écarté durablement. */
await addChatter('anaiis_24', 24, 'paris');
await page.waitForTimeout(400);
check('alias : « anaiis_24 » est signalé', (await aliasMarkers()).some((m) => m.nick === 'anaiis_24'), await aliasMarkers());
await page.locator('#chatters .cell-username', { hasText: /^anaiis_24$/ }).click({ button: 'right' });
await page.locator('[data-action="alias-ignore"]').click();
await page.waitForTimeout(500);
check('alias : écarté, l\'anneau disparaît',
  !(await aliasMarkers()).some((m) => m.nick === 'anaiis_24'), await aliasMarkers());
check('alias : l\'alias écarté est mémorisé',
  await page.evaluate(() => Boolean(globalThis.__entagStore.aliasIgnore && globalThis.__entagStore.aliasIgnore['anaiis_24|anais-24'])));

/* Réglage : détection coupée puis rétablie. */
await page.evaluate(() => browser.storage.local.set({ settings: { detectAliases: false } }));
await addChatter('anais__24', 24, 'Paris');
await page.waitForTimeout(500);
check('alias : aucun anneau quand la détection est coupée', (await aliasMarkers()).length === 0, await aliasMarkers());
await page.evaluate(() => browser.storage.local.set({ settings: {} }));
await page.waitForTimeout(500);
check('alias : anneau de retour quand la détection est rétablie',
  (await aliasMarkers()).some((m) => m.nick === 'anais__24'), await aliasMarkers());

/* Historique des pseudos vus (âge / ville lus dans la liste). */
await page.evaluate(() => Promise.all(globalThis.__entagSend({ type: 'entag:flush-seen' })));
const seenStore = await page.evaluate(() => globalThis.__entagStore.seen || {});
check('historique : âge et ville de anais-24 appris depuis la liste',
  seenStore['anais-24'] && seenStore['anais-24'].age === 24 && seenStore['anais-24'].city === 'paris', seenStore['anais-24']);
check('historique : ville « Massy » de Soraka apprise', seenStore['soraka'] && seenStore['soraka'].city === 'Massy', seenStore['soraka']);
check('historique : ville à plusieurs mots (« Avec le loups »)', seenStore['signit'] && seenStore['signit'].city === 'Avec le loups', seenStore['signit']);

/* 10. Popup : panneau « Alias » sous un pseudo tagué ------------------------- */
const popup = await browser.newPage();
await popup.addInitScript(MOCK_API);
await popup.addInitScript(`Object.assign(globalThis.__entagStore, {
  tags: { 'anais-24': { nick: 'anais-24', tag: 'red', note: 'arnaque', updatedAt: 1 } },
  seen: {
    'anais-24': { nick: 'anais-24', age: 24, city: 'paris', last: ${Date.now()} },
    'anais_24': { nick: 'anais_24', age: 24, city: 'Paris', last: ${Date.now() - 3600000} },
    'anaiss-24': { nick: 'anaiss-24', last: ${Date.now() - 86400000 * 3} },
    'leakitty': { nick: 'leakitty', age: 18, city: 'Rennes', last: ${Date.now()} }
  }
});`);
await popup.goto(pathToFileURL(join(root, 'src/popup/popup.html')).href);
await popup.waitForTimeout(250);
await popup.locator('[data-action="alias"]').click();
await popup.waitForTimeout(150);
const candNicks = await popup.locator('.cand').evaluateAll((els) => els.map((e) => e.dataset.nick));
check('popup : le panneau liste les alias possibles, le plus probable d\'abord',
  candNicks.length === 2 && candNicks[0] === 'anais_24' && candNicks[1] === 'anaiss-24', candNicks);
check('popup : profil connu affiché (24 ans · paris)', /24 ans · paris/.test(await popup.locator('.alias-head').textContent()));
check('popup : score, raisons et dernière vue affichés',
  /\d+ %/.test(await popup.locator('.cand').first().textContent()) && /vu il y a/.test(await popup.locator('.cand').first().textContent()));
await popup.locator('.cand[data-nick="anais_24"] [data-action="link"]').click();
await popup.waitForTimeout(250);
const popupLinked = await popup.evaluate(() => globalThis.__entagStore.tags['anais_24']);
check('popup : « Lier » crée l\'alias avec le même tag',
  popupLinked && popupLinked.tag === 'red' && popupLinked.aliasOf === 'anais-24', popupLinked);
check('popup : la ligne de l\'alias indique « alias de anais-24 »', /alias de anais-24/.test(await popup.locator('.list').textContent()));
check('popup : l\'alias lié n\'est plus proposé comme candidat',
  (await popup.locator('.cand').evaluateAll((els) => els.map((e) => e.dataset.nick))).join() === 'anaiss-24');
await popup.locator('.cand[data-nick="anaiss-24"] [data-action="ignore"]').click();
await popup.waitForTimeout(250);
check('popup : « Ce n\'est pas lui » retire le candidat',
  (await popup.locator('.cand').count()) === 0 &&
  await popup.evaluate(() => Boolean(globalThis.__entagStore.aliasIgnore['anaiss-24|anais-24'])));

/* 11. Ordre d'apparition : le candidat est listé AVANT le pseudo tagué ------- */
await page.goto(pathToFileURL(join(here, 'fixture-chatteurs.html')).href);
await page.evaluate(() => {
  globalThis.__entagStore.tags = { 'anais-24': { nick: 'anais-24', tag: 'yellow', note: '', updatedAt: 1 } };
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<span class="cell-username">anais_24</span><span class="cell">24</span><span class="cell-city">Paris</span>';
  document.getElementById('chatters').insertBefore(row, document.getElementById('chatters').firstChild);
});
await page.addStyleTag({ content: read('src/content/content.css') });
await page.addScriptTag({ content: read('src/common/store.js') });
await page.addScriptTag({ content: read('src/common/alias.js') });
await page.addScriptTag({ content: read('src/content/content.js') });
await page.waitForTimeout(900);
const early = await aliasMarkers();
check('alias : détecté même si le candidat est listé avant le pseudo tagué',
  early.length === 1 && early[0].nick === 'anais_24' && /entag-alias--yellow/.test(early[0].cls), early);
check('alias : le score tient compte de l\'âge et de la ville du pseudo tagué',
  /même ville/.test(early[0] && early[0].title) && /même âge/.test(early[0] && early[0].title), early[0] && early[0].title);

/* 12. Messages privés non lus : glow + remontée dans la barre de gauche (MESSAGES) */
await page.goto(pathToFileURL(join(here, 'fixture-chatteurs.html')).href);
await page.evaluate(() => {
  /* Un bouton après la liste : il doit rester en bas quand une conversation remonte. */
  const add = document.createElement('button');
  add.className = 'add-btn';
  add.textContent = '+';
  document.querySelector('.kiwi-statebrowser').appendChild(add);
});
await page.addStyleTag({ content: read('src/content/content.css') });
await page.addScriptTag({ content: read('src/common/store.js') });
await page.addScriptTag({ content: read('src/common/alias.js') });
await page.addScriptTag({ content: read('src/content/content.js') });
await page.waitForTimeout(400);

const entry = (nick, code) => page.evaluate(([n, body]) => {
  const names = Array.from(document.querySelectorAll('.kiwi-statebrowser-channel-name'));
  const box = names.find((el) => el.textContent.trim() === n).closest('.kiwi-statebrowser-channel');
  return new Function('box', body)(box);
}, [nick, code]);
const leftInfo = (nick) => page.evaluate((n) => {
  const names = Array.from(document.querySelectorAll('.kiwi-statebrowser-channel-name'));
  const box = names.find((el) => el.textContent.trim() === n).closest('.kiwi-statebrowser-channel');
  return { unread: box.hasAttribute('data-entag-unread'), order: box.getAttribute('data-entag-order'), y: box.getBoundingClientRect().top };
}, nick);
const leftOrder = () => page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.kiwi-statebrowser > *'))
    .map((el) => ({
      n: el.tagName === 'H3' ? 'TITRE' : el.tagName === 'BUTTON' ? 'BOUTON'
        : el.querySelector('.kiwi-statebrowser-channel-name').textContent.trim(),
      y: el.getBoundingClientRect().top
    }));
  return items.sort((x, y) => x.y - y.y).map((i) => i.n);
});
const navSorted = () => page.evaluate(() => document.querySelector('.kiwi-statebrowser').getAttribute('data-entag-sorted'));
const rightOrder = () => page.evaluate(() => Array.from(document.querySelectorAll('#chatters .cell-username'))
  .map((e) => ({ n: e.dataset.entagNick, y: e.closest('.row').getBoundingClientRect().top }))
  .sort((x, y) => x.y - y.y).map((r) => r.n));
const rightBubble = (nick) => page.evaluate((n) => {
  const el = Array.from(document.querySelectorAll('#chatters .cell-username')).find((e) => e.dataset.entagNick === n);
  const bubble = el.querySelector('.entag-whisper');
  return { unread: Boolean(bubble && bubble.classList.contains('entag-whisper--unread')), title: bubble ? bubble.title : '' };
}, nick);
const marks = () => page.evaluate(() => document.querySelectorAll('[data-entag-unread], [data-entag-order], [data-entag-sorted]').length);
const counter = (n) => "const s = document.createElement('span'); s.className = 'kiwi-statebrowser-channel-label'; s.textContent = '" + n + "'; box.appendChild(s);";
const noCounter = "const l = box.querySelector('.kiwi-statebrowser-channel-label'); if (l) l.remove();";

check('non lu (gauche) : au départ, rien ne brille et rien n\'est modifié',
  (await marks()) === 0 && (await leftOrder()).join() === 'TITRE,Soraka,anais-24,_petitebrune,BOUTON', await leftOrder());

/* a. Compteur sur la dernière conversation. */
await entry('_petitebrune', counter(3));
await page.waitForTimeout(500);
let info = await leftInfo('_petitebrune');
check('non lu (compteur) : la conversation _petitebrune brille dans MESSAGES', info.unread, info);
check('non lu : elle remonte en tête des conversations, sous le titre et avant le bouton',
  (await leftOrder()).join() === 'TITRE,_petitebrune,Soraka,anais-24,BOUTON', await leftOrder());
check('non lu : l\'ordre dans le DOM n\'a pas été modifié',
  await page.evaluate(() => Array.from(document.querySelectorAll('.kiwi-statebrowser-channel-name')).map((e) => e.textContent.trim()).join() === 'Soraka,anais-24,_petitebrune'));
check('non lu : les autres conversations ne brillent pas',
  !(await leftInfo('Soraka')).unread && !(await leftInfo('anais-24')).unread);
check('non lu : la barre est basculée en colonne flex le temps de la remontée', (await navSorted()) === 'block');
const bubble = await rightBubble('_petitebrune');
check('non lu : à droite, seule la bulle du pseudo passe en « non lu » (avec le nombre)',
  bubble.unread && /non lu/.test(bubble.title) && /\(3\)/.test(bubble.title), bubble);
check('non lu : la liste de droite n\'est ni réordonnée ni illuminée',
  (await rightOrder())[0] === 'Signit' &&
  (await page.evaluate(() => document.querySelectorAll('#chatters [data-entag-unread], #chatters [data-entag-order]').length)) === 0);

/* b. Classe « unread » (changement d'attribut seulement) : plusieurs non lus, ordre de la liste conservé. */
await entry('anais-24', "box.classList.add('kiwi-statebrowser-channel-unread');");
await page.waitForTimeout(500);
check('non lu (classe) : deux non lus remontés dans leur ordre d\'origine',
  (await leftOrder()).join() === 'TITRE,anais-24,_petitebrune,Soraka,BOUTON', await leftOrder());

/* c. Conversation ouverte en ce moment : rien de non lu. */
await entry('anais-24', "box.classList.add('kiwi-statebrowser-channel-active');");
await page.waitForTimeout(500);
check('non lu : la conversation ouverte (active) ne brille plus et redescend',
  !(await leftInfo('anais-24')).unread && (await leftOrder()).join() === 'TITRE,_petitebrune,Soraka,anais-24,BOUTON', await leftOrder());

/* d. Le filtre « masquer les whisp » ne masque jamais quelqu'un qui vient d'écrire. */
await page.evaluate(() => browser.storage.local.set({ settings: { hideWhispered: true } }));
await page.waitForTimeout(500);
check('non lu : _petitebrune (a écrit) reste visible à droite, Soraka (silencieux) est masqué',
  await page.evaluate(() => {
    const row = (n) => Array.from(document.querySelectorAll('#chatters .cell-username'))
      .find((e) => e.dataset.entagNick === n).closest('.row');
    return getComputedStyle(row('_petitebrune')).display !== 'none' && getComputedStyle(row('Soraka')).display === 'none';
  }));
await page.evaluate(() => browser.storage.local.set({ settings: {} }));
await page.waitForTimeout(400);

/* e. Message lu : tout redevient exactement comme avant. */
await entry('_petitebrune', noCounter);
await page.waitForTimeout(500);
check('non lu : une fois lu, plus de glow, ordre d\'origine rétabli, aucun attribut résiduel',
  (await marks()) === 0 && (await leftOrder()).join() === 'TITRE,Soraka,anais-24,_petitebrune,BOUTON', { marks: await marks(), order: await leftOrder() });

/* f. Réglages indépendants : glow seul / remontée seule. */
await entry('_petitebrune', counter(1));
await page.evaluate(() => browser.storage.local.set({ settings: { unreadToTop: false } }));
await page.waitForTimeout(500);
check('réglage « remonter » coupé : ça brille mais ça ne bouge pas',
  (await leftInfo('_petitebrune')).unread && (await leftOrder()).join() === 'TITRE,Soraka,anais-24,_petitebrune,BOUTON', await leftOrder());
await page.evaluate(() => browser.storage.local.set({ settings: { highlightUnread: false } }));
await page.waitForTimeout(500);
check('réglage « glow » coupé : ça remonte sans briller',
  !(await leftInfo('_petitebrune')).unread && (await leftOrder()).join() === 'TITRE,_petitebrune,Soraka,anais-24,BOUTON', await leftOrder());
await page.evaluate(() => browser.storage.local.set({ settings: {} }));
await page.waitForTimeout(400);
await entry('_petitebrune', noCounter);
await page.waitForTimeout(400);

/* g. Sélecteur « non lu » donné dans les options (issue de secours). */
await entry('Soraka', "const i = document.createElement('i'); i.className = 'my-dot'; box.appendChild(i);");
await page.waitForTimeout(400);
check('non lu : sans sélecteur personnalisé, un point inconnu ne compte pas', !(await leftInfo('Soraka')).unread);
await page.evaluate(() => browser.storage.local.set({ settings: { unreadSelectors: ['.my-dot'] } }));
await page.waitForTimeout(500);
check('non lu : sélecteur personnalisé (.my-dot) reconnu', (await leftInfo('Soraka')).unread);
await page.evaluate(() => browser.storage.local.set({ settings: {} }));
await page.waitForTimeout(300);

/* h. Une seule conversation dans la barre de gauche. */
await page.evaluate(() => {
  Array.from(document.querySelectorAll('.kiwi-statebrowser-channel-name'))
    .filter((e) => e.textContent.trim() !== 'Soraka').forEach((e) => e.closest('.kiwi-statebrowser-channel').remove());
});
await entry('Soraka', "box.querySelector('.my-dot').remove();" + counter(4));
await page.waitForTimeout(500);
check('non lu : détecté même avec une seule conversation (glow + bulle « 4 »)',
  (await leftInfo('Soraka')).unread && /\(4\)/.test((await rightBubble('Soraka')).title), await leftInfo('Soraka'));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' tests réussis');
process.exit(failed.length ? 1 : 0);

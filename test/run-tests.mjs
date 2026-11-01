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
  const clone = (v) => JSON.parse(JSON.stringify(v));
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

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(MOCK_API);
await page.goto(pathToFileURL(join(here, 'fixture.html')).href);
await page.addStyleTag({ content: read('src/content/content.css') });
await page.addScriptTag({ content: read('src/common/store.js') });
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

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' tests réussis');
process.exit(failed.length ? 1 : 0);

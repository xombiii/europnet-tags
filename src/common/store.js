/*
 * Couche de données partagée entre le content script, le popup,
 * la page d'options et le script d'arrière-plan.
 *
 * Stockage (browser.storage.local) :
 *   tags        : { "<pseudo en minuscules>": { nick, tag, note, updatedAt, aliasOf? } }
 *   settings    : voir DEFAULT_SETTINGS
 *   seen        : historique local des pseudos vus { "<pseudo>": { nick, age, city, first, last, count } }
 *   aliasIgnore : alias écartés { "<candidat>|<pseudo tagué>": horodatage }
 */
(function (global) {
  'use strict';

  const api = global.browser || global.chrome;

  const TAGS = {
    green: { id: 'green', label: 'Fiable', color: '#22c55e' },
    yellow: { id: 'yellow', label: 'Prudence', color: '#f59e0b' },
    red: { id: 'red', label: 'À éviter', color: '#ef4444' }
  };

  const TAG_ORDER = ['green', 'yellow', 'red'];

  /* Sélecteurs par défaut : classes connues de Kiwi IRC (le tchat EuropNet en
     est dérivé) puis motifs génériques. Ils sont volontairement larges :
     `isValidNick()` filtre ensuite ce qui n'est pas un pseudo. */
  const DEFAULT_SELECTORS = [
    /* Kiwi IRC — messages */
    '.kiwi-messagelist-nick',
    '.kiwi-message-nick',
    '.kiwi-messagelist-message .kiwi-nick',
    /* Kiwi IRC — liste des membres */
    '.kiwi-nicklist-user-nick',
    '.kiwi-nicklist-user .kiwi-nicklist-user-nick',
    '.kiwi-userbox-nick',
    /* Kiwi IRC — barre latérale (salons / messages privés) */
    '.kiwi-statebrowser-channel-name',
    '.kiwi-statebrowser-channel-label',
    /* Motifs génériques */
    '[data-nick]',
    '[data-nickname]',
    '[data-username]',
    '[class*="nick" i]',
    '[class*="username" i]',
    '[class*="user-name" i]',
    '[class*="member-name" i]'
  ];

  const DEFAULT_SETTINGS = {
    showInMessages: true,
    showInNicklist: true,
    showInSidebar: true,
    showWhisperFlag: true,
    hideWhispered: false,
    detectAliases: true,
    badgeSize: 10,
    showNoteTooltip: true,
    contextMenuEnabled: true,
    customSelectors: [],
    disabledSelectors: []
  };

  function normalize(nick) {
    return String(nick || '').trim().toLowerCase();
  }

  async function loadAll() {
    const data = await api.storage.local.get({ tags: {}, settings: {}, aliasIgnore: {} });
    return {
      tags: data.tags || {},
      settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
      aliasIgnore: data.aliasIgnore || {}
    };
  }

  async function loadSettings() {
    const data = await api.storage.local.get({ settings: {} });
    return Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  }

  async function saveSettings(patch) {
    const settings = Object.assign(await loadSettings(), patch);
    await api.storage.local.set({ settings });
    return settings;
  }

  async function loadTags() {
    const data = await api.storage.local.get({ tags: {} });
    return data.tags || {};
  }

  /* extra : { aliasOf } — pseudo tagué dont celui-ci est un alias. */
  async function setTag(nick, tag, note, extra) {
    const key = normalize(nick);
    if (!key) return null;
    const tags = await loadTags();
    const previous = tags[key] || {};
    const entry = {
      nick: String(nick).trim() || previous.nick || key,
      tag: tag || previous.tag || null,
      note: note !== undefined ? String(note || '') : (previous.note || ''),
      updatedAt: Date.now()
    };
    const aliasOf = extra && extra.aliasOf !== undefined ? extra.aliasOf : previous.aliasOf;
    if (aliasOf) entry.aliasOf = String(aliasOf);
    if (!entry.tag && !entry.note) {
      delete tags[key];
    } else {
      tags[key] = entry;
    }
    await api.storage.local.set({ tags });
    return tags[key] || null;
  }

  async function removeTag(nick) {
    const key = normalize(nick);
    const tags = await loadTags();
    if (!(key in tags)) return false;
    delete tags[key];
    await api.storage.local.set({ tags });
    return true;
  }

  async function replaceTags(tags) {
    await api.storage.local.set({ tags: tags || {} });
  }

  /* Fusionne un export dans la base existante.
     mode = 'merge' (les entrées importées gagnent) ou 'replace'. */
  async function importTags(incoming, mode) {
    const clean = {};
    Object.keys(incoming || {}).forEach((rawKey) => {
      const value = incoming[rawKey] || {};
      const nick = String(value.nick || rawKey).trim();
      const key = normalize(nick);
      if (!key) return;
      const tag = TAG_ORDER.includes(value.tag) ? value.tag : null;
      const note = String(value.note || '');
      if (!tag && !note) return;
      clean[key] = {
        nick,
        tag,
        note,
        updatedAt: Number(value.updatedAt) || Date.now()
      };
      if (value.aliasOf) clean[key].aliasOf = String(value.aliasOf);
    });
    const tags = mode === 'replace' ? clean : Object.assign(await loadTags(), clean);
    await api.storage.local.set({ tags });
    return Object.keys(clean).length;
  }

  /* ---------------------------------------------------------------- */
  /* Historique local des pseudos vus (pour la recherche d'alias)       */
  /* ---------------------------------------------------------------- */

  const SEEN_LIMIT = 5000;

  async function loadSeen() {
    const data = await api.storage.local.get({ seen: {} });
    return data.seen || {};
  }

  /* batch : { "<pseudo en minuscules>": { nick, age?, city? } } */
  async function mergeSeen(batch) {
    const keys = Object.keys(batch || {});
    if (!keys.length) return 0;
    const data = await api.storage.local.get({ seen: {}, tags: {} });
    const seen = data.seen || {};
    const now = Date.now();
    keys.forEach((key) => {
      const incoming = batch[key] || {};
      const previous = seen[key] || {};
      seen[key] = {
        nick: incoming.nick || previous.nick || key,
        age: incoming.age || previous.age || null,
        city: incoming.city || previous.city || null,
        first: previous.first || now,
        last: now,
        count: (previous.count || 0) + 1
      };
    });
    const all = Object.keys(seen);
    if (all.length > SEEN_LIMIT) {
      const tags = data.tags || {};
      all
        .filter((key) => !tags[key])
        .sort((a, b) => (seen[a].last || 0) - (seen[b].last || 0))
        .slice(0, all.length - SEEN_LIMIT)
        .forEach((key) => { delete seen[key]; });
    }
    await api.storage.local.set({ seen });
    return keys.length;
  }

  async function clearSeen() {
    await api.storage.local.set({ seen: {}, aliasIgnore: {} });
  }

  async function loadAliasIgnore() {
    const data = await api.storage.local.get({ aliasIgnore: {} });
    return data.aliasIgnore || {};
  }

  /* Pseudo « racine » d'une famille d'alias : on remonte les liens aliasOf. */
  function aliasRoot(tags, key) {
    const visited = new Set();
    let current = key;
    while (tags[current] && tags[current].aliasOf && !visited.has(current)) {
      visited.add(current);
      const next = normalize(tags[current].aliasOf);
      if (!tags[next]) break;
      current = next;
    }
    return current;
  }

  /* « Ce n'est pas lui » : vaut pour tout le groupe d'alias du pseudo tagué, sinon
     le candidat resterait signalé comme alias d'un de ses alias déjà liés. */
  async function ignoreAlias(candidate, taggedNick) {
    const data = await api.storage.local.get({ aliasIgnore: {}, tags: {} });
    const ignore = data.aliasIgnore || {};
    const tags = data.tags || {};
    const who = normalize(candidate);
    const target = normalize(taggedNick);
    const root = aliasRoot(tags, target);
    const now = Date.now();
    ignore[who + '|' + target] = now;
    Object.keys(tags).forEach((key) => {
      if (aliasRoot(tags, key) === root) ignore[who + '|' + key] = now;
    });
    await api.storage.local.set({ aliasIgnore: ignore });
  }

  global.ENTag = {
    api,
    TAGS,
    TAG_ORDER,
    DEFAULT_SELECTORS,
    DEFAULT_SETTINGS,
    normalize,
    loadAll,
    loadTags,
    loadSettings,
    saveSettings,
    setTag,
    removeTag,
    replaceTags,
    importTags,
    loadSeen,
    mergeSeen,
    clearSeen,
    loadAliasIgnore,
    ignoreAlias
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

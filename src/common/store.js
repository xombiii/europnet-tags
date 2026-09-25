/*
 * Couche de données partagée entre le content script, le popup,
 * la page d'options et le script d'arrière-plan.
 *
 * Stockage (browser.storage.local) :
 *   tags     : { "<pseudo en minuscules>": { nick, tag, note, updatedAt } }
 *   settings : voir DEFAULT_SETTINGS
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
    const data = await api.storage.local.get({ tags: {}, settings: {} });
    return {
      tags: data.tags || {},
      settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {})
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

  async function setTag(nick, tag, note) {
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
    });
    const tags = mode === 'replace' ? clean : Object.assign(await loadTags(), clean);
    await api.storage.local.set({ tags });
    return Object.keys(clean).length;
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
    importTags
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

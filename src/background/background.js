/*
 * Script d'arrière-plan : réenregistre le content script sur les domaines
 * supplémentaires autorisés depuis la page d'options (le tchat EuropNet peut
 * être servi par un sous-domaine ou un autre nom de domaine).
 */
(function () {
  'use strict';

  const api = globalThis.ENTag.api;
  const SCRIPT_ID = 'entag-extra-hosts';
  const BUILTIN = ['*://*.europnet.org/*', '*://europnet.org/*'];

  async function extraOrigins() {
    const granted = await api.permissions.getAll();
    return (granted.origins || []).filter((origin) => !BUILTIN.includes(origin));
  }

  async function syncContentScripts() {
    try {
      const existing = await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      if (existing.length) {
        await api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      }
      const matches = await extraOrigins();
      if (!matches.length) return;
      await api.scripting.registerContentScripts([{
        id: SCRIPT_ID,
        matches,
        js: ['src/common/store.js', 'src/content/content.js'],
        css: ['src/content/content.css'],
        runAt: 'document_idle',
        allFrames: true,
        persistAcrossSessions: true
      }]);
    } catch (err) {
      console.warn('[EuropNet Tags] enregistrement des domaines supplémentaires impossible :', err);
    }
  }

  api.runtime.onInstalled.addListener(syncContentScripts);
  api.runtime.onStartup.addListener(syncContentScripts);
  if (api.permissions.onAdded) api.permissions.onAdded.addListener(syncContentScripts);
  if (api.permissions.onRemoved) api.permissions.onRemoved.addListener(syncContentScripts);

  api.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'entag:sync-hosts') {
      return syncContentScripts().then(() => ({ ok: true }));
    }
    return undefined;
  });

  syncContentScripts();
})();

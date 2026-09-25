/* Page d'options. */
(function () {
  'use strict';

  const S = globalThis.ENTag;
  const api = S.api;
  const $ = (id) => document.getElementById(id);

  const BUILTIN_HOSTS = ['*://*.europnet.org/*', '*://europnet.org/*'];
  const CHECKBOXES = ['showInMessages', 'showInNicklist', 'showInSidebar', 'showNoteTooltip', 'contextMenuEnabled'];

  let settings = Object.assign({}, S.DEFAULT_SETTINGS);
  let statusTimer = 0;

  function status(message, isError) {
    const el = $('status');
    el.textContent = message || '';
    el.style.color = isError ? '#b91c1c' : '#2563eb';
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => { el.textContent = ''; }, 3000);
  }

  function validSelector(sel) {
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function persist(patch) {
    settings = await S.saveSettings(patch);
    status('Enregistré');
  }

  /* -------------------------------------------------------------- */
  /* Rendu                                                            */
  /* -------------------------------------------------------------- */

  function renderDefaults() {
    const container = $('default-selectors');
    container.textContent = '';
    const disabled = new Set(settings.disabledSelectors || []);
    S.DEFAULT_SELECTORS.forEach((sel) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !disabled.has(sel);
      box.addEventListener('change', async () => {
        const next = new Set(settings.disabledSelectors || []);
        if (box.checked) next.delete(sel);
        else next.add(sel);
        await persist({ disabledSelectors: Array.from(next) });
      });
      const text = document.createElement('span');
      text.textContent = sel;
      label.append(box, text);
      container.appendChild(label);
    });
  }

  async function renderHosts() {
    const list = $('hosts');
    list.textContent = '';
    const granted = await api.permissions.getAll();
    const origins = (granted.origins || []).filter((o) => !BUILTIN_HOSTS.includes(o));
    if (!origins.length) {
      const li = document.createElement('li');
      li.textContent = 'Aucun domaine supplémentaire.';
      list.appendChild(li);
      return;
    }
    origins.forEach((origin) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = origin;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger';
      button.textContent = 'Retirer';
      button.addEventListener('click', async () => {
        await api.permissions.remove({ origins: [origin] });
        await api.runtime.sendMessage({ type: 'entag:sync-hosts' }).catch(() => {});
        status(origin + ' retiré');
        renderHosts();
      });
      li.append(name, button);
      list.appendChild(li);
    });
  }

  async function renderCount() {
    const tags = await S.loadTags();
    $('tag-count').textContent = Object.keys(tags).length;
  }

  function renderSettings() {
    CHECKBOXES.forEach((key) => { $(key).checked = settings[key] !== false; });
    $('badgeSize').value = settings.badgeSize || 10;
    $('badgeSizeValue').textContent = settings.badgeSize || 10;
    $('customSelectors').value = (settings.customSelectors || []).join('\n');
    renderDefaults();
  }

  /* -------------------------------------------------------------- */
  /* Événements                                                       */
  /* -------------------------------------------------------------- */

  CHECKBOXES.forEach((key) => {
    $(key).addEventListener('change', (event) => persist({ [key]: event.target.checked }));
  });

  $('badgeSize').addEventListener('input', (event) => {
    $('badgeSizeValue').textContent = event.target.value;
  });
  $('badgeSize').addEventListener('change', (event) => persist({ badgeSize: Number(event.target.value) }));

  $('customSelectors').addEventListener('change', async (event) => {
    const lines = event.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
    const invalid = lines.filter((line) => !validSelector(line));
    const error = $('selector-error');
    error.hidden = invalid.length === 0;
    error.textContent = invalid.length ? 'Sélecteur(s) invalide(s), ignoré(s) : ' + invalid.join(' | ') : '';
    await persist({ customSelectors: lines.filter(validSelector) });
  });

  $('host-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('host-input').value.trim();
    if (!value) return;
    try {
      const granted = await api.permissions.request({ origins: [value] });
      if (!granted) return status('Autorisation refusée', true);
      await api.runtime.sendMessage({ type: 'entag:sync-hosts' }).catch(() => {});
      $('host-input').value = '';
      status(value + ' autorisé — recharge l\'onglet du tchat');
      renderHosts();
    } catch (err) {
      status('Motif invalide (exemple : *://*.exemple.org/*)', true);
    }
  });

  $('export').addEventListener('click', async () => {
    const payload = {
      format: 'europnet-tags',
      version: 1,
      exportedAt: new Date().toISOString(),
      tags: await S.loadTags()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'europnet-tags-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status('Export généré');
  });

  let importMode = 'merge';
  $('import').addEventListener('click', () => { importMode = 'merge'; $('import-file').click(); });
  $('import-replace').addEventListener('click', () => { importMode = 'replace'; $('import-file').click(); });

  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const count = await S.importTags(data.tags || data, importMode);
      status(count + ' pseudo(s) importé(s)');
      renderCount();
    } catch (err) {
      status('Fichier illisible', true);
    }
    event.target.value = '';
  });

  $('wipe').addEventListener('click', async () => {
    if (!window.confirm('Supprimer définitivement tous les tags ?')) return;
    await S.replaceTags({});
    status('Tous les tags ont été supprimés');
    renderCount();
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tags) renderCount();
    if (changes.settings) {
      settings = Object.assign({}, S.DEFAULT_SETTINGS, changes.settings.newValue || {});
      renderSettings();
    }
  });

  (async function init() {
    settings = await S.loadSettings();
    renderSettings();
    renderCount();
    renderHosts();
  })();
})();

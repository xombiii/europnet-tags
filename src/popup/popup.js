/* Popup : gestion de la liste des pseudos tagués. */
(function () {
  'use strict';

  const S = globalThis.ENTag;
  const api = S.api;

  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const emptyEl = $('empty');
  const statusEl = $('status');

  let tags = {};
  let filter = 'all';
  let query = '';
  let statusTimer = 0;

  function status(message) {
    statusEl.textContent = message || '';
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 3000);
  }

  function entries() {
    return Object.keys(tags)
      .map((key) => Object.assign({ key }, tags[key]))
      .filter((entry) => filter === 'all' || entry.tag === filter)
      .filter((entry) => {
        if (!query) return true;
        const haystack = (entry.nick + ' ' + (entry.note || '')).toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => a.nick.localeCompare(b.nick, 'fr', { sensitivity: 'base' }));
  }

  function renderCounts() {
    const counts = { green: 0, yellow: 0, red: 0 };
    Object.values(tags).forEach((entry) => {
      if (counts[entry.tag] !== undefined) counts[entry.tag] += 1;
    });
    S.TAG_ORDER.forEach((id) => { $('count-' + id).textContent = counts[id]; });
  }

  function render() {
    renderCounts();
    const rows = entries();
    listEl.textContent = '';
    emptyEl.hidden = rows.length > 0;
    if (!rows.length) {
      emptyEl.textContent = Object.keys(tags).length
        ? 'Aucun résultat pour ce filtre.'
        : "Aucun pseudo tagué pour l'instant. Clic droit sur un pseudo dans le tchat pour en ajouter un.";
      return;
    }

    const fragment = document.createDocumentFragment();
    rows.forEach((entry) => {
      const li = document.createElement('li');
      li.className = 'row';
      li.dataset.key = entry.key;

      const dots = document.createElement('div');
      dots.className = 'dots';
      S.TAG_ORDER.forEach((id) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'dot dot--' + id + (entry.tag === id ? ' is-on' : '');
        dot.dataset.tag = id;
        dot.title = S.TAGS[id].label;
        dot.setAttribute('aria-label', entry.nick + ' : ' + S.TAGS[id].label);
        dots.appendChild(dot);
      });

      const main = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = entry.nick;
      const note = document.createElement('input');
      note.className = 'note';
      note.type = 'text';
      note.maxLength = 300;
      note.placeholder = 'Note…';
      note.value = entry.note || '';
      main.append(name, note);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.dataset.action = 'delete';
      del.textContent = '✕';
      del.title = 'Supprimer ' + entry.nick;

      li.append(dots, main, del);
      fragment.appendChild(li);
    });
    listEl.appendChild(fragment);
  }

  async function reload() {
    tags = await S.loadTags();
    render();
  }

  /* -------------------------------------------------------------- */
  /* Interactions                                                    */
  /* -------------------------------------------------------------- */

  listEl.addEventListener('click', async (event) => {
    const row = event.target.closest('.row');
    if (!row) return;
    const entry = tags[row.dataset.key];
    if (!entry) return;

    const dot = event.target.closest('.dot');
    if (dot) {
      const next = entry.tag === dot.dataset.tag ? null : dot.dataset.tag;
      await S.setTag(entry.nick, next, entry.note || '');
      if (!next && !entry.note) await S.removeTag(entry.nick);
      await reload();
      return;
    }

    if (event.target.closest('[data-action="delete"]')) {
      await S.removeTag(entry.nick);
      status(entry.nick + ' supprimé');
      await reload();
    }
  });

  listEl.addEventListener('change', async (event) => {
    const note = event.target.closest('.note');
    if (!note) return;
    const row = event.target.closest('.row');
    const entry = tags[row.dataset.key];
    if (!entry) return;
    await S.setTag(entry.nick, entry.tag, note.value);
    status('Note enregistrée');
    await reload();
  });

  $('add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const nick = $('add-nick').value.trim();
    if (!nick) return;
    await S.setTag(nick, $('add-tag').value, '');
    $('add-nick').value = '';
    status(nick + ' ajouté');
    await reload();
  });

  $('chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    render();
  });

  $('search').addEventListener('input', (event) => {
    query = event.target.value.trim().toLowerCase();
    render();
  });

  $('options').addEventListener('click', () => api.runtime.openOptionsPage());

  $('pick').addEventListener('click', async () => {
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('onglet introuvable');
      await api.tabs.sendMessage(tab.id, { type: 'entag:pick' });
      window.close();
    } catch (err) {
      status("Ouvre d'abord l'onglet du tchat EuropNet.");
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

  $('import').addEventListener('click', () => $('import-file').click());

  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const count = await S.importTags(data.tags || data, 'merge');
      status(count + ' pseudo(s) importé(s)');
      await reload();
    } catch (err) {
      status('Fichier illisible');
    }
    event.target.value = '';
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.tags) {
      tags = changes.tags.newValue || {};
      render();
    }
  });

  reload();
})();

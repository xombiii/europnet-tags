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
  let seen = {};
  let ignored = {};
  const openPanels = new Set();
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

  function ago(timestamp) {
    if (!timestamp) return '';
    const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (minutes < 2) return "à l'instant";
    if (minutes < 60) return 'il y a ' + minutes + ' min';
    const hours = Math.round(minutes / 60);
    if (hours < 48) return 'il y a ' + hours + ' h';
    return 'il y a ' + Math.round(hours / 24) + ' j';
  }

  function profileText(info) {
    if (!info) return '';
    const parts = [];
    if (info.age) parts.push(info.age + ' ans');
    if (info.city) parts.push(info.city);
    return parts.join(' · ');
  }

  /* Panneau « Alias » d'un pseudo tagué : candidats tirés de l'historique des
     pseudos vus (score, raisons), alias déjà liés. */
  function buildAliasPanel(entry) {
    const li = document.createElement('li');
    li.className = 'alias-panel';
    li.dataset.for = entry.key;

    const info = seen[entry.key];
    const head = document.createElement('p');
    head.className = 'alias-head';
    const known = profileText(info);
    head.textContent = known
      ? 'Profil connu de ' + entry.nick + ' : ' + known + '.'
      : 'Âge et ville de ' + entry.nick + ' inconnus (ils sont lus dans la liste des chatteurs quand il est connecté).';
    li.appendChild(head);

    const linked = Object.keys(tags)
      .map((key) => tags[key])
      .filter((t) => t.aliasOf && S.normalize(t.aliasOf) === entry.key)
      .map((t) => t.nick);
    if (linked.length) {
      const p = document.createElement('p');
      p.className = 'alias-linked';
      p.textContent = 'Alias déjà liés : ' + linked.join(', ');
      li.appendChild(p);
    }

    if (!Object.keys(seen).length) {
      const p = document.createElement('p');
      p.className = 'alias-empty';
      p.textContent = "Aucun pseudo enregistré pour l'instant : ouvre le tchat, l'extension apprend les pseudos qu'elle voit.";
      li.appendChild(p);
      return li;
    }

    const candidates = globalThis.ENAlias.findCandidates(
      { nick: entry.nick, age: info && info.age, city: info && info.city },
      seen,
      (key) => key === entry.key || Boolean(tags[key]) || Boolean(ignored[key + '|' + entry.key]),
      8
    );

    if (!candidates.length) {
      const p = document.createElement('p');
      p.className = 'alias-empty';
      p.textContent = 'Aucun alias probable parmi les ' + Object.keys(seen).length + ' pseudos vus.';
      li.appendChild(p);
      return li;
    }

    candidates.forEach((cand) => {
      const item = document.createElement('div');
      item.className = 'cand cand--' + cand.level;
      item.dataset.key = cand.key;
      item.dataset.nick = cand.nick;

      const top = document.createElement('div');
      top.className = 'cand-top';
      const nick = document.createElement('b');
      nick.textContent = cand.nick;
      const score = document.createElement('span');
      score.className = 'cand-score';
      score.textContent = cand.score + ' % · ' + (cand.level === 'probable' ? 'probable' : 'possible');
      top.append(nick, score);

      const why = document.createElement('div');
      why.className = 'cand-why';
      const meta = [profileText(cand), cand.last ? 'vu ' + ago(cand.last) : ''].filter(Boolean).join(' · ');
      why.textContent = cand.reasons.join(', ') + (meta ? ' — ' + meta : '');

      const actions = document.createElement('div');
      actions.className = 'cand-actions';
      const link = document.createElement('button');
      link.type = 'button';
      link.dataset.action = 'link';
      link.textContent = 'Lier (même tag)';
      const ignore = document.createElement('button');
      ignore.type = 'button';
      ignore.dataset.action = 'ignore';
      ignore.textContent = "Ce n'est pas lui";
      actions.append(link, ignore);

      item.append(top, why, actions);
      li.appendChild(item);
    });
    return li;
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
      if (entry.aliasOf) {
        const from = document.createElement('span');
        from.className = 'alias-of';
        from.textContent = ' ↳ alias de ' + entry.aliasOf;
        name.appendChild(from);
      }
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

      const acts = document.createElement('div');
      acts.className = 'acts';
      const alias = document.createElement('button');
      alias.type = 'button';
      alias.className = 'alias-btn' + (openPanels.has(entry.key) ? ' is-on' : '');
      alias.dataset.action = 'alias';
      alias.textContent = 'Alias';
      alias.title = 'Chercher les alias de ' + entry.nick;
      alias.setAttribute('aria-expanded', String(openPanels.has(entry.key)));
      acts.append(alias, del);

      li.append(dots, main, acts);
      fragment.appendChild(li);
      if (openPanels.has(entry.key)) fragment.appendChild(buildAliasPanel(entry));
    });
    listEl.appendChild(fragment);
  }

  async function reload() {
    tags = await S.loadTags();
    seen = await S.loadSeen();
    ignored = await S.loadAliasIgnore();
    render();
  }

  /* -------------------------------------------------------------- */
  /* Interactions                                                    */
  /* -------------------------------------------------------------- */

  listEl.addEventListener('click', async (event) => {
    const cand = event.target.closest('.cand');
    if (cand) {
      const panel = cand.closest('.alias-panel');
      const owner = panel && tags[panel.dataset.for];
      const action = event.target.closest('button') && event.target.closest('button').dataset.action;
      if (!owner || !action) return;
      if (action === 'link') {
        if (!owner.tag) {
          status('Donne d\'abord un tag à ' + owner.nick);
          return;
        }
        const note = 'Alias de ' + owner.nick + (owner.note ? ' — ' + owner.note : '');
        await S.setTag(cand.dataset.nick, owner.tag, note, { aliasOf: owner.nick });
        status(cand.dataset.nick + ' lié à ' + owner.nick);
      } else if (action === 'ignore') {
        await S.ignoreAlias(cand.dataset.nick, owner.nick);
        status('Alias écarté');
      }
      await reload();
      return;
    }

    const row = event.target.closest('.row');
    if (!row) return;
    const entry = tags[row.dataset.key];
    if (!entry) return;

    if (event.target.closest('[data-action="alias"]')) {
      if (openPanels.has(row.dataset.key)) openPanels.delete(row.dataset.key);
      else openPanels.add(row.dataset.key);
      render();
      return;
    }

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
    if (area !== 'local') return;
    if (changes.tags) tags = changes.tags.newValue || {};
    if (changes.seen) seen = changes.seen.newValue || {};
    if (changes.aliasIgnore) ignored = changes.aliasIgnore.newValue || {};
    if (changes.tags || ((changes.seen || changes.aliasIgnore) && openPanels.size)) render();
  });

  reload();
})();

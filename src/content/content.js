/*
 * EuropNet — Tags de fiabilité (content script)
 *
 * 1. repère les pseudos dans la page (liste des membres, messages du salon,
 *    barre latérale des messages privés, résultats de recherche) ;
 * 2. colle une pastille verte / jaune / rouge à la fin de chaque pseudo tagué ;
 * 3. ouvre un menu au clic droit sur un pseudo pour poser / retirer un tag ;
 * 4. propose un mode « pipette » pour apprendre un sélecteur si le site change ;
 * 5. pose un flag « whisp » (bulle bleue) dans la liste des membres sur les
 *    pseudos avec qui une conversation privée est ouverte dans la barre de
 *    gauche (rubrique MESSAGES) ;
 * 6. propose un bouton pour masquer ces pseudos de la liste des membres ;
 * 7. repère les alias probables des pseudos tagués (pseudo proche, même âge /
 *    même ville lus dans la liste) et propose de leur appliquer le même tag ;
 * 8. fait briller (glow) dans la liste de droite les pseudos dont une conversation
 *    privée contient des messages non lus, et les fait remonter en haut.
 */
(function () {
  'use strict';

  const S = globalThis.ENTag;
  const api = S.api;

  const OWN_CLASSES = '.entag-badge, .entag-alias, .entag-whisper, .entag-filter, .entag-menu, .entag-toast';
  /* Liste des membres (à droite). */
  const NICKLIST_SCOPE = '[class*="nicklist" i], [class*="memberlist" i], [class*="userlist" i], ' +
    '[class*="member-list" i], [class*="user-list" i]';
  /* Barre de gauche (salons + messages privés) : source des conversations
     privées ouvertes. */
  const STATE_SCOPE = '[class*="statebrowser" i], [class*="channellist" i]';
  const NICK_RE = /^[A-Za-z0-9_\-\[\]{}\\^`|.]{2,32}$/;
  const MODE_PREFIX_RE = /^[@%+~&!]+/;
  /* Symboles de genre / variantes emoji collés au pseudo dans EuropNet. */
  const DECORATION_RE = /[\u2640\u2642\u26A5\u26A7\u200B-\u200D\uFE0E\uFE0F\u00A0]/g;

  const A = globalThis.ENAlias;
  /* Ordre des repères collés à la fin d'un pseudo. */
  const OWN_ORDER = ['entag-badge', 'entag-alias', 'entag-whisper'];
  /* Signaux d'une conversation non lue dans la barre de gauche. */
  const UNREAD_CLASS_RE = /unread|highlight|activity|notif|alert|mention|blink|flash/i;
  const CURRENT_CLASS_RE = /(?:^|[\s_-])(?:active|selected|current)(?:$|[\s_-])/i;
  const SEEN_FLUSH_MS = 8000;
  const WHISPER_REFRESH_MS = 150;  /* regroupe les changements de la barre de gauche */
  const CHIP_REFRESH_MS = 200;     /* idem pour la position du bouton de filtre */
  const SEEN_REFRESH_MS = 10 * 60 * 1000;

  let state = { tags: {}, settings: Object.assign({}, S.DEFAULT_SETTINGS), aliasIgnore: {} };
  let selector = '';
  let ready = false;
  let observer = null;
  let scanScheduled = false;
  let pickMode = false;
  let whisperNicks = new Set();
  /* Messages privés non lus : pseudo en minuscules → nombre (>= 1). */
  let whisperUnread = new Map();
  /* Historique des pseudos vus : clé → { nick, age, city, sent } */
  const seenKnown = new Map();
  let seenQueue = {};
  let seenTimer = 0;
  const aliasCache = new Map();
  const profileCache = new WeakMap();
  /* Éléments de pseudo par pseudo (minuscules) : sert à ne redécorer que ceux
     dont l'état change, au lieu de rebalayer toute la page. */
  const nickEls = new Map();
  /* Entrées de la barre de gauche (une par conversation) et leurs conteneurs. */
  let entrySet = new Set();
  let listParents = new Set();
  let structureEpoch = 0;
  const entryCache = new WeakMap();
  let whisperTimer = 0;

  /* ------------------------------------------------------------------ */
  /* Sélecteurs                                                          */
  /* ------------------------------------------------------------------ */

  function buildSelector() {
    const disabled = new Set(state.settings.disabledSelectors || []);
    const list = S.DEFAULT_SELECTORS
      .filter((sel) => !disabled.has(sel))
      .concat(state.settings.customSelectors || []);
    const valid = [];
    list.forEach((sel) => {
      const trimmed = String(sel || '').trim();
      if (!trimmed) return;
      try {
        document.createDocumentFragment().querySelector(trimmed);
        valid.push(trimmed);
      } catch (err) {
        /* sélecteur invalide saisi dans les options : on l'ignore */
      }
    });
    selector = valid.join(', ');
  }

  /* ------------------------------------------------------------------ */
  /* Extraction du pseudo                                                */
  /* ------------------------------------------------------------------ */

  function cleanNick(raw) {
    return String(raw || '')
      .replace(DECORATION_RE, '')
      .trim()
      .replace(MODE_PREFIX_RE, '')
      .replace(/[\s:,>]+$/, '')
      .trim();
  }

  function isValidNick(nick) {
    if (!nick) return false;
    if (/^\d+$/.test(nick)) return false;
    return NICK_RE.test(nick);
  }

  function extractNick(el) {
    const attr = el.getAttribute('data-nick') || el.getAttribute('data-nickname') ||
      el.getAttribute('data-username') || el.getAttribute('data-user');
    if (attr) return cleanNick(attr);

    let direct = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) direct += node.textContent;
    }
    if (cleanNick(direct)) return cleanNick(direct);

    /* Pas de texte direct : on accepte le texte complet si l'élément est
       simple (pseudo + icône de genre), pour éviter d'avaler un message. */
    if (el.children.length <= 3 && el.textContent.length <= 40) {
      return cleanNick(el.textContent);
    }
    return '';
  }

  /* Nom de salon (#BDSM) : ce n'est pas un pseudo. */
  function looksLikeChannel(el) {
    const text = (el.textContent || '').trim();
    return text.startsWith('#');
  }

  /* ------------------------------------------------------------------ */
  /* Zones de la page                                                    */
  /* ------------------------------------------------------------------ */

  function zoneOf(el) {
    if (el.closest(NICKLIST_SCOPE)) {
      return 'nicklist';
    }
    if (el.closest('[class*="messagelist" i], [class*="message-list" i], [class*="messages" i], [class*="chat" i]')) {
      return 'message';
    }
    if (el.closest('[class*="statebrowser" i], [class*="sidebar" i], [class*="channellist" i], nav, aside')) {
      return 'sidebar';
    }
    return 'other';
  }

  function zoneEnabled(zone) {
    const s = state.settings;
    if (zone === 'nicklist') return s.showInNicklist !== false;
    if (zone === 'message') return s.showInMessages !== false;
    if (zone === 'sidebar') return s.showInSidebar !== false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Pastilles                                                           */
  /* ------------------------------------------------------------------ */

  const VOID_TAGS = new Set(['INPUT', 'IMG', 'BR', 'HR', 'TEXTAREA', 'SELECT']);

  function existingOwn(el, cls) {
    if (VOID_TAGS.has(el.tagName)) {
      for (let n = el.nextElementSibling; n && isOurNode(n); n = n.nextElementSibling) {
        if (n.classList.contains(cls)) return n;
      }
      return null;
    }
    return el.querySelector(':scope > .' + cls);
  }

  function existingBadge(el) {
    return existingOwn(el, 'entag-badge');
  }

  function existingFlag(el) {
    return existingOwn(el, 'entag-whisper');
  }

  function rankOf(node) {
    for (let i = 0; i < OWN_ORDER.length; i += 1) {
      if (node.classList.contains(OWN_ORDER[i])) return i;
    }
    return OWN_ORDER.length;
  }

  /* Ordre fixe à la fin du pseudo : pastille de fiabilité, alias, flag whisp. */
  function attachOwn(el, node) {
    const rank = rankOf(node);
    if (VOID_TAGS.has(el.tagName)) {
      let anchor = el;
      for (let n = el.nextElementSibling; n && isOurNode(n) && rankOf(n) < rank; n = n.nextElementSibling) {
        anchor = n;
      }
      anchor.insertAdjacentElement('afterend', node);
      return;
    }
    const after = Array.from(el.children).find((child) => isOurNode(child) && rankOf(child) > rank);
    if (after) el.insertBefore(node, after);
    else el.appendChild(node);
  }

  function tooltipFor(entry) {
    const meta = S.TAGS[entry.tag];
    let text = entry.nick + ' — ' + (meta ? meta.label : entry.tag);
    if (entry.note && state.settings.showNoteTooltip !== false) text += '\n' + entry.note;
    return text;
  }

  function syncBadge(el, nick, zone, badge) {
    const entry = state.tags[nick.toLowerCase()];

    if (!entry || !entry.tag || !zoneEnabled(zone)) {
      if (badge) badge.remove();
      return;
    }

    const node = badge || document.createElement('span');
    node.className = 'entag-badge entag-badge--' + entry.tag;
    node.dataset.entagFor = nick;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', tooltipFor(entry));
    node.title = tooltipFor(entry);
    node.style.setProperty('--entag-size', (state.settings.badgeSize || 10) + 'px');

    if (!badge) attachOwn(el, node);
  }

  /* Le flag whisp apparaît sur tout pseudo hors du salon (liste des membres,
     recherche, fiche) dont une conversation privée est ouverte à gauche. */
  function isWhisperTarget(el, nick, zone) {
    if (zone === 'message' || el.closest(STATE_SCOPE)) return false;
    return whisperNicks.has(nick.toLowerCase());
  }

  function syncWhisperFlag(el, nick, flag, target, unread) {
    if (!target || state.settings.showWhisperFlag === false) {
      if (flag) flag.remove();
      return;
    }

    const node = flag || document.createElement('span');
    const text = unread
      ? 'Message privé non lu de ' + nick + (unread > 1 ? ' (' + unread + ')' : '')
      : 'Conversation privée ouverte avec ' + nick;
    node.className = 'entag-whisper' + (unread ? ' entag-whisper--unread' : '');
    node.dataset.entagWhisperFor = nick;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', text);
    node.title = text;

    if (!flag) attachOwn(el, node);
  }

  function trackEl(key, el) {
    let set = nickEls.get(key);
    if (!set) {
      set = new Set();
      nickEls.set(key, set);
    }
    if (set.has(el)) return;
    set.add(el);
    if (set.size > 20) set.forEach((node) => { if (!node.isConnected) set.delete(node); });
  }

  /* Redécore uniquement les éléments des pseudos dont l'état whisp / non lu a changé. */
  function rescanNicks(keys) {
    keys.forEach((key) => {
      const set = nickEls.get(key);
      if (!set) return;
      set.forEach((node) => {
        if (node.isConnected) decorate(node);
        else set.delete(node);
      });
    });
    scheduleChipUpdate();
  }

  function decorate(el) {
    if (!el || !el.isConnected) return;
    if (el.closest(OWN_CLASSES)) return;
    if (looksLikeChannel(el)) return;

    const badge = existingBadge(el);
    const flag = existingFlag(el);
    const marker = existingOwn(el, 'entag-alias');

    /* Un conteneur (ex. .kiwi-nicklist-user) peut matcher en même temps que le
       pseudo qu'il contient : seul l'élément le plus interne est décoré. */
    if (selector && el.querySelector(selector)) {
      if (badge) badge.remove();
      if (flag) flag.remove();
      if (marker) marker.remove();
      showRowOf(el);
      return;
    }

    const nick = extractNick(el);

    if (!isValidNick(nick)) {
      if (badge) badge.remove();
      if (flag) flag.remove();
      if (marker) marker.remove();
      delete el.dataset.entagWhispered;
      showRowOf(el);
      return;
    }

    el.dataset.entagNick = nick;
    if (!el.classList.contains('entag-nick')) el.classList.add('entag-nick');
    trackEl(nick.toLowerCase(), el);

    const zone = zoneOf(el);
    const target = isWhisperTarget(el, nick, zone);
    const unread = target ? (whisperUnread.get(nick.toLowerCase()) || 0) : 0;
    syncBadge(el, nick, zone, badge);
    syncWhisperFlag(el, nick, flag, target, unread);
    syncWhisperRow(el, target, unread);

    const inList = zone !== 'message' && !el.closest(STATE_SCOPE);
    noteSeen(nick, inList ? profileOf(el, nick) : null);
    syncAliasMarker(el, nick, marker);
  }

  /* ------------------------------------------------------------------ */
  /* Alias probables des pseudos tagués                                   */
  /* ------------------------------------------------------------------ */

  /* Âge et ville lus sur la ligne de la liste (« Signit  18  Avec le loups ») :
     on retire le pseudo, le premier nombre de 13 à 99 est l'âge, le reste la ville.
     Rien n'est supposé sur les classes CSS du site ; si la ligne n'a pas cette
     forme, on ne renvoie rien. */
  function profileOf(el, nick) {
    const cached = profileCache.get(el);
    if (cached && cached.nick === nick) return cached.profile;

    let profile = null;
    const row = rowOf(el, false);
    if (row && row !== el) {
      /* Morceaux de texte de la ligne hors pseudo, séparés par une espace :
         `textContent` collerait les cellules (« Signit18Avec le loups »). */
      const pieces = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (el.contains(node) || (node.parentElement && node.parentElement.closest(OWN_CLASSES))) continue;
        const piece = node.textContent.replace(DECORATION_RE, ' ').trim();
        if (piece) pieces.push(piece);
      }
      const text = pieces.join(' ')
        .replace(/(^|\s)[@%+~&!]+(?=\s|$)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const match = /(?:^|\s)(1[3-9]|[2-9]\d)(?=\s|$)/.exec(text);
      if (match) {
        const city = text.slice(match.index + match[0].length).trim().slice(0, 40);
        profile = { age: Number(match[1]), city: city || null };
      }
    }
    profileCache.set(el, { nick, profile });
    return profile;
  }

  function flushSeen() {
    clearTimeout(seenTimer);
    seenTimer = 0;
    const batch = seenQueue;
    seenQueue = {};
    if (!Object.keys(batch).length) return Promise.resolve(0);
    return S.mergeSeen(batch).catch(() => 0);
  }

  function noteSeen(nick, profile) {
    if (state.settings.detectAliases === false) return;
    const key = nick.toLowerCase();
    const known = seenKnown.get(key);
    const age = (profile && profile.age) || null;
    const city = (profile && profile.city) || null;
    const changed = !known ||
      (age && known.age !== age) ||
      (city && known.city !== city) ||
      Date.now() - known.sent > SEEN_REFRESH_MS;
    if (!changed) return;

    seenKnown.set(key, {
      nick,
      age: age || (known && known.age) || null,
      city: city || (known && known.city) || null,
      sent: Date.now()
    });
    seenQueue[key] = { nick, age, city };
    aliasCache.delete(key);
    /* Le profil d'un pseudo tagué vient d'être appris : les scores déjà calculés
       pour les autres pseudos sont à refaire (un seul rebalayage, pas de boucle :
       le profil est alors connu). */
    if (state.tags[key] && ((age && (!known || known.age !== age)) || (city && (!known || known.city !== city)))) {
      aliasCache.clear();
      scheduleFullScan();
    }
    if (!seenTimer) seenTimer = setTimeout(flushSeen, SEEN_FLUSH_MS);
  }

  /* Meilleur alias probable de `nick` parmi les pseudos tagués (ou null). */
  function aliasFor(nick) {
    if (!A || state.settings.detectAliases === false) return null;
    const key = nick.toLowerCase();
    if (state.tags[key]) return null;
    if (aliasCache.has(key)) return aliasCache.get(key);

    const known = seenKnown.get(key) || {};
    const candidate = { nick, age: known.age, city: known.city };
    let best = null;
    Object.keys(state.tags).forEach((tagKey) => {
      const tagged = state.tags[tagKey];
      if (!tagged || !tagged.tag) return;
      if (state.aliasIgnore[key + '|' + tagKey]) return;
      const info = seenKnown.get(tagKey) || {};
      const result = A.score({ nick: tagged.nick, age: info.age, city: info.city }, candidate);
      if (result.score >= A.THRESHOLD && (!best || result.score > best.score)) {
        best = Object.assign({ of: tagged }, result);
      }
    });
    aliasCache.set(key, best);
    return best;
  }

  function aliasTitle(info) {
    const meta = S.TAGS[info.of.tag];
    return 'Alias ' + (info.level === 'probable' ? 'probable' : 'possible') + ' de ' + info.of.nick +
      (meta ? ' (' + meta.label + ')' : '') + ' — ' + info.score + ' %\n' + info.reasons.join('\n') +
      '\nClic pour appliquer son tag ou écarter.';
  }

  function syncAliasMarker(el, nick, marker) {
    const info = aliasFor(nick);
    if (!info) {
      if (marker) marker.remove();
      return;
    }
    const node = marker || document.createElement('span');
    node.className = 'entag-alias entag-alias--' + info.of.tag;
    node.dataset.entagAliasFor = nick;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', aliasTitle(info));
    node.title = aliasTitle(info);
    node.style.setProperty('--entag-size', (state.settings.badgeSize || 10) + 'px');
    if (!marker) attachOwn(el, node);
  }

  /* ------------------------------------------------------------------ */
  /* Filtre : masquer les pseudos en conversation privée                  */
  /* ------------------------------------------------------------------ */

  const FLAGGED = '.entag-nick[data-entag-whispered]';
  /* Le bouton ne compte que ceux qu'il peut masquer (pas ceux qui ont écrit). */
  const FLAGGED_HIDEABLE = '.entag-nick[data-entag-whispered="1"]';
  const ROW_STOP_TAGS = /^(UL|OL|NAV|MAIN|ASIDE|TABLE|TBODY|THEAD|SECTION)$/;

  /* Nombre de pseudos différents dans un élément (on s'arrête à `limit`). */
  function countNicks(root, limit) {
    const nicks = new Set();
    if (!selector) return 0;
    let list;
    try {
      list = root.querySelectorAll(selector);
    } catch (err) {
      return 0;
    }
    for (const node of list) {
      if (node.closest(OWN_CLASSES)) continue;
      const nick = extractNick(node);
      if (!isValidNick(nick)) continue;
      nicks.add(nick.toLowerCase());
      if (limit && nicks.size >= limit) break;
    }
    return nicks.size;
  }

  function containsChannel(root) {
    if (!selector) return false;
    let list;
    try {
      list = root.querySelectorAll(selector);
    } catch (err) {
      return false;
    }
    for (const node of list) {
      if (!node.closest(OWN_CLASSES) && looksLikeChannel(node)) return true;
    }
    return false;
  }

  /* Ligne de la liste qui contient ce pseudo (celle qu'on masque) : on remonte
     tant que le parent ne contient que ce pseudo, sans jamais englober un champ
     de saisie (filtres, recherche). Renvoie null si le pseudo n'est pas dans une
     liste (fiche isolée, fenêtre de profil...) : on ne masque alors rien. */
  function rowOf(el, useGeometry) {
    const base = useGeometry === false ? { height: 0 } : el.getBoundingClientRect();
    let row = el;
    for (let i = 0; i < 6; i += 1) {
      const parent = row.parentElement;
      if (!parent || parent === document.body || ROW_STOP_TAGS.test(parent.tagName)) break;
      if (countNicks(parent, 2) > 1) break;
      if (containsChannel(parent)) break;
      if (parent.querySelector('input, textarea, select')) break;
      /* Une ligne reste de la hauteur d'un pseudo : au-delà, c'est un bloc. */
      if (base.height > 0 && parent.getBoundingClientRect().height > Math.max(60, base.height * 4)) break;
      row = parent;
    }
    const container = row.parentElement;
    return container && countNicks(container, 2) > 1 ? row : null;
  }

  function showRowOf(el) {
    const row = el.closest('[data-entag-hidden]');
    if (row) row.removeAttribute('data-entag-hidden');
  }

  /* Libère le conteneur d'une liste quand plus aucune ligne n'y est remontée. */
  function releaseBox(box) {
    if (box && !box.querySelector('[data-entag-top]')) box.removeAttribute('data-entag-sorted');
  }

  /* Glow + remontée en haut d'une ligne de la liste (message privé non lu).
     L'ordre passe par le CSS (`order`), jamais par un déplacement d'éléments :
     le site garde la main sur sa liste. Un conteneur « block » est basculé en
     colonne flex pour que `order` s'applique ; table ou autre : on ne touche à rien. */
  function syncUnreadRow(el, unread) {
    const wantGlow = unread > 0 && state.settings.highlightUnread !== false;
    const wantTop = unread > 0 && state.settings.unreadToTop !== false;
    let row = el.closest('[data-entag-unread], [data-entag-top]');

    if (!wantGlow && !wantTop) {
      if (row) {
        row.removeAttribute('data-entag-unread');
        row.removeAttribute('data-entag-top');
        releaseBox(row.parentElement);
      }
      return;
    }

    row = row || rowOf(el);
    if (!row) return;
    row.toggleAttribute('data-entag-unread', wantGlow);
    row.toggleAttribute('data-entag-top', wantTop);
    if (wantTop) {
      const box = row.parentElement;
      if (box && !box.hasAttribute('data-entag-sorted')) {
        const display = getComputedStyle(box).display;
        if (display === 'block' || display === 'flex' || display === 'grid') {
          box.setAttribute('data-entag-sorted', display);
        }
      }
    } else {
      releaseBox(row.parentElement);
    }
  }

  function syncWhisperRow(el, target, unread) {
    if (target) el.dataset.entagWhispered = unread ? 'unread' : '1';
    else delete el.dataset.entagWhispered;

    syncUnreadRow(el, target ? unread : 0);

    /* Une personne qui vient d'écrire n'est jamais masquée par le filtre. */
    if (target && !unread && state.settings.hideWhispered === true) {
      if (!el.closest('[data-entag-hidden]')) {
        const row = rowOf(el);
        if (row) row.setAttribute('data-entag-hidden', '');
      }
    } else {
      showRowOf(el);
    }
  }

  let filterChip = null;
  let chipScheduled = false;
  let listAnchor = null;

  function scheduleChipUpdate() {
    if (chipScheduled) return;
    chipScheduled = true;
    setTimeout(updateFilterChip, CHIP_REFRESH_MS);
  }

  async function toggleHideWhispered() {
    const next = state.settings.hideWhispered !== true;
    state.settings = await S.saveSettings({ hideWhispered: next });
    scan(document.body);
    toast(next ? 'Conversations privées masquées dans la liste' : 'Conversations privées de nouveau visibles');
  }

  function ensureFilterChip() {
    if (filterChip && filterChip.isConnected) return filterChip;
    filterChip = document.createElement('button');
    filterChip.type = 'button';
    filterChip.className = 'entag-filter';
    filterChip.hidden = true;
    filterChip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleHideWhispered();
    });
    filterChip.addEventListener('contextmenu', (event) => event.stopPropagation());
    document.body.appendChild(filterChip);
    return filterChip;
  }

  /* Panneau de la liste où se trouvent les pseudos whisp : on part du premier
     pseudo concerné, on remonte jusqu'au bloc qui contient plusieurs pseudos
     (la liste) puis jusqu'au parent le plus haut qui ne contient pas d'autres
     pseudos (liste + filtres, sans le salon). Aucune classe CSS du site n'est
     supposée. */
  function findListAnchor() {
    const flagged = document.querySelectorAll(FLAGGED);
    for (let i = 0; i < flagged.length && i < 5; i += 1) {
      let node = flagged[i].parentElement;
      for (let depth = 0; node && node !== document.body && depth < 12; depth += 1) {
        if (countNicks(node, 3) >= 3) break;
        node = node.parentElement;
      }
      if (!node || node === document.body) continue;
      const total = countNicks(node);
      let best = node;
      for (let p = node.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (countNicks(p) !== total) break;
        best = p;
      }
      return best;
    }
    return null;
  }

  /* Bouton flottant, accroché en bas du panneau de la liste. */
  function updateFilterChip() {
    chipScheduled = false;
    if (!document.body) return;
    /* Aucun pseudo concerné et pas de bouton à cacher : rien à mesurer. */
    if (!filterChip && !document.querySelector(FLAGGED)) return;

    if (!listAnchor || !listAnchor.isConnected || !listAnchor.querySelector(FLAGGED)) {
      const found = findListAnchor();
      if (found) listAnchor = found;
      else if (listAnchor && !listAnchor.isConnected) listAnchor = null;
    }

    const active = state.settings.hideWhispered === true;
    const count = listAnchor ? listAnchor.querySelectorAll(FLAGGED_HIDEABLE).length : 0;
    const rect = listAnchor ? listAnchor.getBoundingClientRect() : null;
    const visible = rect && rect.width > 80 && rect.height > 40 && (count > 0 || active);

    if (!visible) {
      if (filterChip) filterChip.hidden = true;
      return;
    }

    const chip = ensureFilterChip();
    chip.textContent = active
      ? 'Whisp masqués (' + count + ') — afficher'
      : 'Masquer les whisp (' + count + ')';
    chip.setAttribute('aria-pressed', String(active));
    chip.title = 'Masque dans la liste les pseudos avec qui une conversation privée est déjà ouverte';
    chip.classList.toggle('is-active', active);
    chip.hidden = false;

    const width = chip.offsetWidth;
    const height = chip.offsetHeight;
    const bottom = Math.min(rect.bottom, window.innerHeight);
    const right = Math.min(rect.right, window.innerWidth);
    chip.style.left = Math.max(4, right - width - 8) + 'px';
    chip.style.top = Math.max(4, bottom - height - 8) + 'px';
  }

  /* ------------------------------------------------------------------ */
  /* Conversations privées ouvertes (rubrique MESSAGES, à gauche)         */
  /* ------------------------------------------------------------------ */

  /* Entrée de la barre de gauche (conversation) d'un pseudo : le plus grand
     ancêtre (6 niveaux au plus) qui ne contient aucun autre pseudo ni salon.
     `others` = tous les éléments pseudo / salon de la barre. */
  function entryFor(el, others) {
    const cached = entryCache.get(el);
    if (cached && cached.epoch === structureEpoch && cached.entry.isConnected && cached.entry.contains(el)) {
      return cached.entry;
    }
    let node = el;
    for (let i = 0; i < 6; i += 1) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || ROW_STOP_TAGS.test(parent.tagName)) break;
      let shared = false;
      for (const other of others) {
        if (other !== el && parent.contains(other)) {
          shared = true;
          break;
        }
      }
      if (shared) break;
      node = parent;
    }
    entryCache.set(el, { entry: node, epoch: structureEpoch });
    return node;
  }

  function classText(node) {
    return (node.getAttribute && node.getAttribute('class')) || '';
  }

  /* Nombre de messages non lus signalé par l'entrée de la barre de gauche (0 = aucun).
     Aucune classe du site n'est supposée : on cherche un compteur (petit nombre à
     côté du pseudo), un attribut ou un nom de classe explicite (unread, highlight...),
     ou un sélecteur donné par l'utilisateur dans les options. */
  function unreadOf(el, entry) {
    if (!entry) return 0;

    /* Conversation ouverte en ce moment : rien n'est « non lu ». */
    for (let node = el; node; node = node.parentElement) {
      const current = node.getAttribute && node.getAttribute('aria-current');
      if (CURRENT_CLASS_RE.test(classText(node)) || node.getAttribute('aria-selected') === 'true' ||
          (current && current !== 'false')) return 0;
      if (node === entry) break;
    }

    for (const sel of state.settings.unreadSelectors || []) {
      try {
        if (entry.matches(sel) || entry.querySelector(sel)) return 1;
      } catch (err) {
        /* sélecteur invalide : ignoré */
      }
    }

    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (el.contains(node) || (node.parentElement && node.parentElement.closest(OWN_CLASSES))) continue;
      const match = /^(\d{1,3})\+?$/.exec(node.textContent.trim());
      if (match && Number(match[1]) > 0) return Number(match[1]);
    }

    const nodes = [entry].concat(Array.from(entry.querySelectorAll('*')));
    for (const node of nodes) {
      if (node.closest(OWN_CLASSES)) continue;
      const flag = node.getAttribute('data-unread') || node.getAttribute('data-has-unread');
      if (flag && flag !== 'false' && flag !== '0') return Number(flag) > 0 ? Number(flag) : 1;
      if (UNREAD_CLASS_RE.test(classText(node))) return 1;
    }
    return 0;
  }

  function collectWhisperState() {
    const nicks = new Set();
    const unread = new Map();
    const entries = new Set();
    const parents = new Set();
    if (!selector) return { nicks, unread, entries, parents };

    /* Une seule recherche par bloc de premier niveau (les blocs imbriqués
       portent aussi « statebrowser » dans leur classe). */
    const found = [];
    const others = [];
    document.querySelectorAll(STATE_SCOPE).forEach((box) => {
      if (box.closest(OWN_CLASSES)) return;
      if (box.parentElement && box.parentElement.closest(STATE_SCOPE)) return;
      let list;
      try {
        list = box.querySelectorAll(selector);
      } catch (err) {
        return;
      }
      list.forEach((el) => {
        if (el.closest(OWN_CLASSES) || el.querySelector(selector)) return;
        if (looksLikeChannel(el)) {
          others.push(el);
          return;
        }
        const nick = extractNick(el);
        if (!isValidNick(nick)) return;
        found.push({ el, key: nick.toLowerCase() });
        others.push(el);
      });
    });

    found.forEach(({ el, key }) => {
      nicks.add(key);
      const entry = entryFor(el, others);
      entries.add(entry);
      if (entry.parentElement) parents.add(entry.parentElement);
      const count = unreadOf(el, entry);
      if (count > 0) unread.set(key, Math.max(count, unread.get(key) || 0));
    });
    return { nicks, unread, entries, parents };
  }

  /* Recalcule conversations ouvertes et non lues ; renvoie les pseudos dont l'état a changé. */
  function refreshWhisper() {
    const next = collectWhisperState();
    const changed = new Set();
    whisperNicks.forEach((key) => { if (!next.nicks.has(key)) changed.add(key); });
    next.nicks.forEach((key) => { if (!whisperNicks.has(key)) changed.add(key); });
    whisperUnread.forEach((count, key) => { if (next.unread.get(key) !== count) changed.add(key); });
    next.unread.forEach((count, key) => { if (whisperUnread.get(key) !== count) changed.add(key); });
    whisperNicks = next.nicks;
    whisperUnread = next.unread;
    entrySet = next.entries;
    listParents = next.parents;
    return Array.from(changed);
  }

  function scheduleWhisperRefresh() {
    if (whisperTimer) return;
    whisperTimer = setTimeout(() => {
      whisperTimer = 0;
      const changed = refreshWhisper();
      if (changed.length) rescanNicks(changed);
    }, WHISPER_REFRESH_MS);
  }

  function scan(root) {
    if (!ready || !selector) return;
    const scope = root && root.nodeType === Node.ELEMENT_NODE ? root : document.body;
    if (!scope) return;
    if (scope === document.body) refreshWhisper();
    if (scope.matches && scope.matches(selector)) decorate(scope);
    let found;
    try {
      found = scope.querySelectorAll(selector);
    } catch (err) {
      return;
    }
    found.forEach(decorate);
    if (scope === document.body) scheduleChipUpdate();
  }

  function scheduleFullScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    const run = () => {
      scanScheduled = false;
      scan(document.body);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
    else setTimeout(run, 100);
  }

  /* ------------------------------------------------------------------ */
  /* Observation du DOM                                                  */
  /* ------------------------------------------------------------------ */

  function isOurNode(node) {
    return node.nodeType === Node.ELEMENT_NODE &&
      (node.classList.contains('entag-badge') || node.classList.contains('entag-whisper') ||
       node.classList.contains('entag-alias') || node.classList.contains('entag-filter') || node.classList.contains('entag-menu') || node.classList.contains('entag-toast'));
  }

  /* Mutation qui n'ajoute / retire que nos propres éléments : on l'ignore. */
  function onlyOurNodes(record) {
    if (record.type !== 'childList') return false;
    const nodes = Array.from(record.addedNodes).concat(Array.from(record.removedNodes));
    return nodes.length > 0 && nodes.every(isOurNode);
  }

  /* La mutation concerne-t-elle une conversation de la barre de gauche ?
     (contenu d'une entrée, ou entrée ajoutée / retirée). Un lecteur audio ou
     tout autre élément de la barre qui bouge sans cesse est ignoré. */
  function stateRecordRelevant(record) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (!target) return false;
    const inScope = target.closest(STATE_SCOPE);
    const nodes = record.type === 'childList'
      ? Array.from(record.addedNodes).concat(Array.from(record.removedNodes))
      : [];
    const elements = nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE && !isOurNode(n));

    if (record.type === 'childList' && elements.length) {
      const addsBox = elements.some((n) => n.matches(STATE_SCOPE) || n.querySelector(STATE_SCOPE));
      if (!inScope && !addsBox) return false;
      if (elements.some((n) => entrySet.has(n))) {
        structureEpoch += 1;
        return true;
      }
      try {
        if (elements.some((n) => n.matches(selector) || n.querySelector(selector))) {
          structureEpoch += 1;
          return true;
        }
      } catch (err) {
        return false;
      }
    }
    if (!inScope || !entrySet.size) return Boolean(inScope);
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      if (entrySet.has(node)) return true;
    }
    return false;
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      const roots = new Set();
      let stateTouched = false;
      for (const record of records) {
        /* Changement de classe : seule la barre de gauche nous intéresse (une
           conversation passe en « non lue »). */
        if (record.type === 'attributes') {
          const t = record.target;
          if (!stateTouched && t instanceof Element && !t.closest(OWN_CLASSES) && stateRecordRelevant(record)) {
            stateTouched = true;
          }
          continue;
        }
        if (onlyOurNodes(record)) continue;
        if (!stateTouched && stateRecordRelevant(record)) stateTouched = true;
        if (record.type === 'characterData') {
          const parent = record.target.parentElement;
          if (parent && !parent.closest(OWN_CLASSES)) roots.add(parent);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            if (record.target && !record.target.closest(OWN_CLASSES)) roots.add(record.target);
            continue;
          }
          if (isOurNode(node)) continue;
          roots.add(node);
        }
      }
      /* Conversation privée ouverte, fermée ou devenue non lue : mise à jour
         regroupée, limitée aux pseudos concernés. */
      if (stateTouched) scheduleWhisperRefresh();
      if (!roots.size) return;
      scheduleChipUpdate();
      if (roots.size > 40) {
        scheduleFullScan();
        return;
      }
      roots.forEach((root) => {
        if (root.isConnected) scan(root);
      });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  /* ------------------------------------------------------------------ */
  /* Menu contextuel                                                     */
  /* ------------------------------------------------------------------ */

  let menu = null;
  let menuNick = '';

  function buildMenu() {
    const el = document.createElement('div');
    el.className = 'entag-menu';
    el.hidden = true;
    el.innerHTML =
      '<div class="entag-menu__header"><span class="entag-menu__nick"></span></div>' +
      '<div class="entag-menu__alias" hidden>' +
        '<div class="entag-menu__alias-text"></div>' +
        '<div class="entag-menu__alias-actions">' +
          '<button type="button" class="entag-menu__link" data-action="alias-apply">Appliquer son tag</button>' +
          '<button type="button" class="entag-menu__link" data-action="alias-ignore">Ce n\'est pas lui</button>' +
        '</div>' +
      '</div>' +
      '<div class="entag-menu__items">' +
        S.TAG_ORDER.map((id) =>
          '<button type="button" class="entag-menu__item" data-tag="' + id + '">' +
            '<span class="entag-swatch entag-swatch--' + id + '"></span>' +
            '<span>' + S.TAGS[id].label + '</span>' +
          '</button>').join('') +
        '<button type="button" class="entag-menu__item entag-menu__item--muted" data-action="clear">' +
          '<span class="entag-swatch entag-swatch--none"></span><span>Retirer le tag</span>' +
        '</button>' +
      '</div>' +
      '<div class="entag-menu__note">' +
        '<input type="text" class="entag-menu__input" placeholder="Note (Entrée pour enregistrer)" maxlength="300">' +
      '</div>' +
      '<div class="entag-menu__footer">' +
        '<button type="button" class="entag-menu__link" data-action="copy">Copier le pseudo</button>' +
        '<button type="button" class="entag-menu__link" data-action="close">Fermer</button>' +
      '</div>';
    document.body.appendChild(el);

    el.addEventListener('click', onMenuClick);
    el.addEventListener('contextmenu', (e) => e.stopPropagation());
    el.querySelector('.entag-menu__input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        saveNote();
      } else if (e.key === 'Escape') {
        closeMenu();
      }
    });
    return el;
  }

  function ensureMenu() {
    if (!menu || !menu.isConnected) menu = buildMenu();
    return menu;
  }

  function openMenu(nick, x, y) {
    const el = ensureMenu();
    menuNick = nick;
    const entry = state.tags[nick.toLowerCase()] || {};
    el.querySelector('.entag-menu__nick').textContent = nick;
    el.querySelector('.entag-menu__input').value = entry.note || '';
    const alias = aliasFor(nick);
    const aliasBox = el.querySelector('.entag-menu__alias');
    aliasBox.hidden = !alias;
    if (alias) {
      const meta = S.TAGS[alias.of.tag];
      el.querySelector('.entag-menu__alias-text').textContent =
        'Alias ' + (alias.level === 'probable' ? 'probable' : 'possible') + ' de ' + alias.of.nick +
        (meta ? ' (' + meta.label + ')' : '') + ' — ' + alias.score + ' % : ' + alias.reasons.join(', ') + '.';
    }
    el.querySelectorAll('[data-tag]').forEach((btn) => {
      btn.classList.toggle('is-active', entry.tag === btn.dataset.tag);
    });
    el.hidden = false;

    const rect = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function closeMenu() {
    if (menu) menu.hidden = true;
    menuNick = '';
  }

  async function applyTag(tag) {
    if (!menuNick) return;
    const note = menu.querySelector('.entag-menu__input').value;
    await S.setTag(menuNick, tag, note);
    toast(tag ? menuNick + ' : ' + S.TAGS[tag].label : 'Tag retiré pour ' + menuNick);
    closeMenu();
  }

  async function clearTag() {
    if (!menuNick) return;
    await S.removeTag(menuNick);
    toast('Tag retiré pour ' + menuNick);
    closeMenu();
  }

  async function applyAlias() {
    const nick = menuNick;
    const info = nick && aliasFor(nick);
    if (!info) return closeMenu();
    const typed = menu.querySelector('.entag-menu__input').value.trim();
    const note = 'Alias de ' + info.of.nick + (typed ? ' — ' + typed : (info.of.note ? ' — ' + info.of.note : ''));
    await S.setTag(nick, info.of.tag, note, { aliasOf: info.of.nick });
    toast(nick + ' : même tag que ' + info.of.nick + ' (' + S.TAGS[info.of.tag].label + ')');
    closeMenu();
  }

  async function ignoreAliasFor() {
    const nick = menuNick;
    const info = nick && aliasFor(nick);
    if (!info) return closeMenu();
    await S.ignoreAlias(nick, info.of.nick);
    toast(nick + ' : alias écarté');
    closeMenu();
  }

  async function saveNote() {
    if (!menuNick) return;
    const note = menu.querySelector('.entag-menu__input').value;
    const entry = state.tags[menuNick.toLowerCase()] || {};
    await S.setTag(menuNick, entry.tag || null, note);
    toast('Note enregistrée pour ' + menuNick);
    closeMenu();
  }

  function onMenuClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.tag) return void applyTag(button.dataset.tag);
    const action = button.dataset.action;
    if (action === 'clear') return void clearTag();
    if (action === 'alias-apply') return void applyAlias();
    if (action === 'alias-ignore') return void ignoreAliasFor();
    if (action === 'close') return closeMenu();
    if (action === 'copy') {
      const nick = menuNick;
      navigator.clipboard.writeText(nick).then(
        () => toast('Pseudo copié : ' + nick),
        () => toast('Copie impossible')
      );
      closeMenu();
    }
  }

  function nickElementFrom(target) {
    if (!(target instanceof Element)) return null;
    const badge = target.closest('.entag-badge, .entag-alias');
    if (badge) {
      const owner = badge.parentElement;
      if (owner && owner.dataset.entagNick) return owner;
    }
    if (!selector) return null;
    const el = target.closest(selector);
    if (!el || el.closest(OWN_CLASSES)) return null;
    const nick = el.dataset.entagNick || extractNick(el);
    return isValidNick(nick) && !looksLikeChannel(el) ? el : null;
  }

  function onContextMenu(event) {
    if (pickMode) return;
    if (state.settings.contextMenuEnabled === false) return;
    if (event.target.closest('.entag-menu')) return;
    const el = nickElementFrom(event.target);
    if (!el) return;
    const nick = el.dataset.entagNick || extractNick(el);
    if (!isValidNick(nick)) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(nick, event.clientX, event.clientY);
  }

  function onBadgeClick(event) {
    const badge = event.target.closest('.entag-badge, .entag-alias');
    if (!badge) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(badge.dataset.entagFor || badge.dataset.entagAliasFor, event.clientX, event.clientY);
  }

  /* ------------------------------------------------------------------ */
  /* Mode pipette (apprentissage d'un sélecteur)                         */
  /* ------------------------------------------------------------------ */

  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).filter((c) =>
      /^[A-Za-z][\w-]*$/.test(c) && c.length < 40 && !/\d{3,}/.test(c) && !c.startsWith('entag-'));
    const meaningful = classes.filter((c) => /nick|user|member|pseudo|author/i.test(c));
    if (meaningful.length) return tag + '.' + meaningful[0];
    if (classes.length) return tag + classes.map((c) => '.' + c).join('');
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id)) return '#' + el.id;
    return null;
  }

  function setPickMode(enabled) {
    pickMode = enabled;
    document.documentElement.classList.toggle('entag-picking', enabled);
    if (enabled) toast('Mode pipette : clique sur un pseudo (Échap pour annuler)', 4000);
  }

  async function onPickClick(event) {
    if (!pickMode) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    setPickMode(false);
    if (!target) return;

    /* On remonte jusqu'à 3 niveaux pour trouver un élément dont le texte
       ressemble à un pseudo. */
    let el = target;
    for (let i = 0; i < 4 && el; i += 1) {
      const nick = extractNick(el);
      const sel = selectorFor(el);
      if (sel && isValidNick(nick)) {
        const settings = await S.saveSettings({
          customSelectors: Array.from(new Set((state.settings.customSelectors || []).concat(sel)))
        });
        state.settings = settings;
        buildSelector();
        scan(document.body);
        toast('Sélecteur ajouté : ' + sel + ' (pseudo détecté : ' + nick + ')', 5000);
        return;
      }
      el = el.parentElement;
    }
    toast('Aucun pseudo reconnu ici. Réessaie sur le texte du pseudo.', 4000);
  }

  /* ------------------------------------------------------------------ */
  /* Notifications                                                       */
  /* ------------------------------------------------------------------ */

  let toastEl = null;
  let toastTimer = 0;

  function toast(message, duration) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.className = 'entag-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), duration || 2500);
  }

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                           */
  /* ------------------------------------------------------------------ */

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (pickMode) setPickMode(false);
    if (menu && !menu.hidden) closeMenu();
  }

  function onDocumentPointerDown(event) {
    if (menu && !menu.hidden && !event.target.closest('.entag-menu')) closeMenu();
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    /* L'historique des pseudos vus (clé « seen ») change souvent : il ne
       déclenche aucun rebalayage de la page. */
    let rescan = false;
    if (changes.tags) {
      state.tags = changes.tags.newValue || {};
      aliasCache.clear();
      rescan = true;
    }
    if (changes.settings) {
      state.settings = Object.assign({}, S.DEFAULT_SETTINGS, changes.settings.newValue || {});
      buildSelector();
      aliasCache.clear();
      rescan = true;
    }
    if (changes.aliasIgnore) {
      state.aliasIgnore = changes.aliasIgnore.newValue || {};
      aliasCache.clear();
      rescan = true;
    }
    if (rescan) scheduleFullScan();
  });

  api.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return undefined;
    if (message.type === 'entag:ping') {
      return Promise.resolve({ ok: true, tagged: Object.keys(state.tags).length });
    }
    if (message.type === 'entag:pick') {
      setPickMode(true);
      return Promise.resolve({ ok: true });
    }
    if (message.type === 'entag:flush-seen') {
      return flushSeen().then((count) => ({ ok: true, count }));
    }
    if (message.type === 'entag:rescan') {
      buildSelector();
      scan(document.body);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  async function init() {
    state = await S.loadAll();
    const seen = await S.loadSeen();
    Object.keys(seen).forEach((key) => {
      const info = seen[key] || {};
      seenKnown.set(key, { nick: info.nick || key, age: info.age || null, city: info.city || null, sent: info.last || 0 });
    });
    buildSelector();
    ready = true;
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('click', onBadgeClick, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('mousedown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', () => {
      closeMenu();
      scheduleChipUpdate();
    }, true);
    window.addEventListener('resize', scheduleChipUpdate);
    window.addEventListener('pagehide', () => { void flushSeen(); });
    startObserver();
    scan(document.body);
  }

  init();
})();

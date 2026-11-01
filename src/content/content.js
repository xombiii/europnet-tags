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
 *    gauche (rubrique MESSAGES).
 */
(function () {
  'use strict';

  const S = globalThis.ENTag;
  const api = S.api;

  const OWN_CLASSES = '.entag-badge, .entag-whisper, .entag-menu, .entag-toast';
  /* Barre de gauche (salons + messages privés) : source des conversations
     privées ouvertes. */
  const STATE_SCOPE = '[class*="statebrowser" i], [class*="channellist" i]';
  const NICK_RE = /^[A-Za-z0-9_\-\[\]{}\\^`|.]{2,32}$/;
  const MODE_PREFIX_RE = /^[@%+~&!]+/;
  /* Symboles de genre / variantes emoji collés au pseudo dans EuropNet. */
  const DECORATION_RE = /[\u2640\u2642\u26A5\u26A7\u200B-\u200D\uFE0E\uFE0F\u00A0]/g;

  let state = { tags: {}, settings: Object.assign({}, S.DEFAULT_SETTINGS) };
  let selector = '';
  let ready = false;
  let observer = null;
  let scanScheduled = false;
  let pickMode = false;
  let whisperNicks = new Set();

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
    if (el.closest('[class*="nicklist" i], [class*="memberlist" i], [class*="userlist" i], [class*="member-list" i], [class*="user-list" i]')) {
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

  /* Ordre fixe à la fin du pseudo : pastille de fiabilité, puis flag whisp. */
  function attachBadge(el, node) {
    const flag = existingFlag(el);
    if (VOID_TAGS.has(el.tagName)) el.insertAdjacentElement('afterend', node);
    else if (flag) el.insertBefore(node, flag);
    else el.appendChild(node);
  }

  function attachFlag(el, node) {
    const badge = existingBadge(el);
    if (VOID_TAGS.has(el.tagName)) (badge || el).insertAdjacentElement('afterend', node);
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

    if (!badge) attachBadge(el, node);
  }

  /* Le flag whisp apparaît sur tout pseudo hors du salon (liste des membres,
     recherche, fiche) dont une conversation privée est ouverte à gauche. */
  function wantsWhisperFlag(el, nick, zone) {
    if (state.settings.showWhisperFlag === false) return false;
    if (zone === 'message' || el.closest(STATE_SCOPE)) return false;
    return whisperNicks.has(nick.toLowerCase());
  }

  function syncWhisperFlag(el, nick, zone, flag) {
    if (!wantsWhisperFlag(el, nick, zone)) {
      if (flag) flag.remove();
      return;
    }

    const node = flag || document.createElement('span');
    const text = 'Conversation privée ouverte avec ' + nick;
    node.className = 'entag-whisper';
    node.dataset.entagWhisperFor = nick;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', text);
    node.title = text;

    if (!flag) attachFlag(el, node);
  }

  function decorate(el) {
    if (!el || !el.isConnected) return;
    if (el.closest(OWN_CLASSES)) return;
    if (looksLikeChannel(el)) return;

    const badge = existingBadge(el);
    const flag = existingFlag(el);

    /* Un conteneur (ex. .kiwi-nicklist-user) peut matcher en même temps que le
       pseudo qu'il contient : seul l'élément le plus interne est décoré. */
    if (selector && el.querySelector(selector)) {
      if (badge) badge.remove();
      if (flag) flag.remove();
      return;
    }

    const nick = extractNick(el);

    if (!isValidNick(nick)) {
      if (badge) badge.remove();
      if (flag) flag.remove();
      return;
    }

    el.dataset.entagNick = nick;
    el.classList.add('entag-nick');

    const zone = zoneOf(el);
    syncBadge(el, nick, zone, badge);
    syncWhisperFlag(el, nick, zone, flag);
  }

  /* ------------------------------------------------------------------ */
  /* Conversations privées ouvertes (rubrique MESSAGES, à gauche)         */
  /* ------------------------------------------------------------------ */

  function collectWhisperNicks() {
    const found = new Set();
    if (!selector) return found;
    document.querySelectorAll(STATE_SCOPE).forEach((box) => {
      if (box.closest(OWN_CLASSES)) return;
      let list;
      try {
        list = box.querySelectorAll(selector);
      } catch (err) {
        return;
      }
      list.forEach((el) => {
        if (el.closest(OWN_CLASSES) || looksLikeChannel(el) || el.querySelector(selector)) return;
        const nick = extractNick(el);
        if (isValidNick(nick)) found.add(nick.toLowerCase());
      });
    });
    return found;
  }

  /* Recalcule la liste ; renvoie true si elle a changé. */
  function refreshWhisper() {
    const next = collectWhisperNicks();
    let changed = next.size !== whisperNicks.size;
    if (!changed) {
      for (const nick of next) {
        if (!whisperNicks.has(nick)) {
          changed = true;
          break;
        }
      }
    }
    whisperNicks = next;
    return changed;
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
       node.classList.contains('entag-menu') || node.classList.contains('entag-toast'));
  }

  /* Mutation qui n'ajoute / retire que nos propres éléments : on l'ignore. */
  function onlyOurNodes(record) {
    if (record.type !== 'childList') return false;
    const nodes = Array.from(record.addedNodes).concat(Array.from(record.removedNodes));
    return nodes.length > 0 && nodes.every(isOurNode);
  }

  /* La mutation touche-t-elle la barre de gauche (conversations privées) ? */
  function touchesState(record) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target && target.closest(STATE_SCOPE)) return true;
    if (record.type !== 'childList') return false;
    const nodes = Array.from(record.addedNodes).concat(Array.from(record.removedNodes));
    return nodes.some((n) => n.nodeType === Node.ELEMENT_NODE &&
      (n.matches(STATE_SCOPE) || n.querySelector(STATE_SCOPE)));
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      const roots = new Set();
      let stateTouched = false;
      for (const record of records) {
        if (onlyOurNodes(record)) continue;
        if (!stateTouched && touchesState(record)) stateTouched = true;
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
      /* Conversation privée ouverte ou fermée : on remet à jour les flags. */
      if (stateTouched && refreshWhisper()) scheduleFullScan();
      if (!roots.size) return;
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
      characterData: true
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
    const badge = target.closest('.entag-badge');
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
    const badge = event.target.closest('.entag-badge');
    if (!badge) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(badge.dataset.entagFor, event.clientX, event.clientY);
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
    if (changes.tags) state.tags = changes.tags.newValue || {};
    if (changes.settings) {
      state.settings = Object.assign({}, S.DEFAULT_SETTINGS, changes.settings.newValue || {});
      buildSelector();
    }
    scheduleFullScan();
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
    if (message.type === 'entag:rescan') {
      buildSelector();
      scan(document.body);
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  async function init() {
    state = await S.loadAll();
    buildSelector();
    ready = true;
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('click', onBadgeClick, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('mousedown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', () => closeMenu(), true);
    startObserver();
    scan(document.body);
  }

  init();
})();

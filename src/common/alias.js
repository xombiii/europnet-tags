/*
 * Détection d'alias : « ce pseudo ressemble-t-il à un pseudo que j'ai tagué ? »
 *
 * Module pur (aucun accès au DOM ni au stockage), partagé entre le content
 * script et le popup. Il compare deux profils { nick, age?, city? } et renvoie
 * un score de 0 à 100 avec la liste des raisons. Ce n'est jamais une preuve :
 * c'est un indice, affiché avec ses raisons.
 *
 * Signaux :
 *   - ressemblance des pseudos (noyau lettres identique, contenu, presque
 *     identique, même début) ; sans cela, aucun score (un même âge + une même
 *     ville ne suffisent pas à désigner quelqu'un) ;
 *   - même nombre dans le pseudo (« anais-24 » / « anais_24 ») ;
 *   - même ville, même âge (ou âge voisin) ; âge très différent = malus.
 */
(function (global) {
  'use strict';

  const THRESHOLD = 55;  /* en dessous : on ne signale rien */
  const PROBABLE = 75;   /* au-dessus : « alias probable » */

  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

  function fold(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /* « Noyau » en lettres seules : « _Anaïs-24 » → « anais », « m4itresse_75 » →
     « maitresse ». Les chiffres et séparateurs en début / fin de pseudo sont
     écartés avant de lire les chiffres du milieu comme des lettres (leet). */
  function core(nick) {
    return fold(nick)
      .replace(/^[^a-z]+/, '')
      .replace(/[^a-z]+$/, '')
      .replace(/[013457@$]/g, (c) => LEET[c])
      .replace(/[^a-z]/g, '');
  }

  function digits(nick) {
    return (String(nick || '').match(/\d+/g) || []).join('');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      previous = current;
    }
    return previous[b.length];
  }

  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
  }

  function normCity(city) {
    const text = fold(city).replace(/[^a-z]/g, '');
    return text.length >= 3 ? text : '';
  }

  /* Score de ressemblance des seuls pseudos. */
  function nickSimilarity(nickA, nickB) {
    const a = core(nickA);
    const b = core(nickB);
    const shorter = Math.min(a.length, b.length);
    const result = { score: 0, reason: '' };
    if (shorter < 4) return result;

    const consider = (score, reason) => {
      if (score > result.score) {
        result.score = score;
        result.reason = reason;
      }
    };

    if (a === b) {
      consider(40 + Math.min(20, (a.length - 4) * 3), 'même pseudo de base (« ' + a + ' »)');
      return result;
    }
    if (shorter >= 5 && (a.includes(b) || b.includes(a))) {
      consider(40 + Math.min(10, (shorter - 5) * 2), 'un pseudo contient l\'autre');
    }
    const similarity = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    if (shorter >= 5 && similarity >= 0.8) {
      consider(33 + Math.round((similarity - 0.8) * 50), 'pseudos presque identiques');
    }
    const prefix = commonPrefix(a, b);
    if (prefix >= 6 && prefix >= shorter * 0.6) {
      consider(28, 'même début de pseudo (« ' + a.slice(0, prefix) + ' »)');
    }
    return result;
  }

  /* a, b : { nick, age?, city? } → { score, level, reasons } */
  function score(a, b) {
    const none = { score: 0, level: 'none', reasons: [] };
    if (!a || !b || !a.nick || !b.nick) return none;
    if (fold(a.nick).trim() === fold(b.nick).trim()) return none;

    const base = nickSimilarity(a.nick, b.nick);
    if (!base.score) return none;

    let total = base.score;
    const reasons = [base.reason];

    const da = digits(a.nick);
    const db = digits(b.nick);
    if (da && da === db && da.length >= 2) {
      total += 15;
      reasons.push('même nombre dans le pseudo (' + da + ')');
    }

    const cityA = normCity(a.city);
    if (cityA && cityA === normCity(b.city)) {
      total += 25;
      reasons.push('même ville (' + String(b.city).trim() + ')');
    }

    const ageA = Number(a.age);
    const ageB = Number(b.age);
    if (ageA && ageB) {
      const gap = Math.abs(ageA - ageB);
      if (gap === 0) {
        total += 15;
        reasons.push('même âge (' + ageA + ' ans)');
      } else if (gap <= 2) {
        total += 5;
        reasons.push('âge voisin (' + ageA + ' / ' + ageB + ' ans)');
      } else if (gap > 3) {
        total -= 15;
        reasons.push('âge très différent (' + ageA + ' / ' + ageB + ' ans)');
      }
    }

    total = Math.max(0, Math.min(100, total));
    return {
      score: total,
      level: total >= PROBABLE ? 'probable' : total >= THRESHOLD ? 'possible' : 'none',
      reasons
    };
  }

  /* Cherche, parmi les pseudos déjà vus (« seen » : { clé: { nick, age, city, last } }),
     ceux qui ressemblent à `target`. `skip(key)` écarte une clé. */
  function findCandidates(target, seen, skip, limit) {
    const out = [];
    Object.keys(seen || {}).forEach((key) => {
      if (skip && skip(key)) return;
      const other = seen[key] || {};
      const result = score(target, { nick: other.nick || key, age: other.age, city: other.city });
      if (result.score >= THRESHOLD) {
        out.push(Object.assign({ key, nick: other.nick || key, age: other.age, city: other.city, last: other.last }, result));
      }
    });
    out.sort((x, y) => (y.score - x.score) || ((y.last || 0) - (x.last || 0)));
    return out.slice(0, limit || 12);
  }

  global.ENAlias = { THRESHOLD, PROBABLE, core, digits, score, findCandidates };
})(typeof globalThis !== 'undefined' ? globalThis : window);

# EuropNet — Tags de fiabilité (extension Firefox)

Extension Firefox qui ajoute un **indicateur de fiabilité** (🟢 vert / 🟡 jaune / 🔴 rouge)
à côté des pseudos du tchat EuropNet, avec une liste de pseudos tagués conservée
localement dans le navigateur.

## Fonctionnalités

- **Clic droit sur un pseudo** (n'importe où dans le tchat) → menu pour poser
  ou retirer un tag et saisir une note libre.
- **Pastille affichée à la fin du pseudo** dans les trois zones de la page :
  - la **barre latérale gauche** (salons / messages privés — ex. `cassandre0075`) ;
  - le **salon au centre**, à chaque message écrit par la personne ;
  - la **liste des membres à droite**, y compris quand elle est filtrée par la recherche
    (la recherche réutilise la même liste, les tags suivent automatiquement).
- **Flag « whisp »** : quand une conversation privée est ouverte avec un pseudo
  (il figure dans la rubrique MESSAGES à gauche), une petite bulle bleue s'affiche
  sur ce même pseudo dans la liste des membres / la recherche à droite, avec sa
  pastille de fiabilité s'il est tagué. Le flag disparaît quand la conversation
  est fermée et se désactive dans les options.
- **Bouton « Masquer les whisp (N) »** en bas de la liste des membres : un clic
  masque de la liste tous les pseudos avec qui une conversation privée est déjà
  ouverte (la ligne entière disparaît), un second clic les réaffiche. Le compteur
  suit les ouvertures / fermetures de conversations ; le choix est mémorisé et
  réglable aussi dans les options.
- **Messages privés non lus** : dans la barre de gauche, la conversation qui contient des
  messages non lus **brille en bleu** et **remonte en haut de la rubrique MESSAGES** (sous son
  titre, avant les conversations lues, qui restent dessous dans leur ordre). Dans la liste de
  droite, la bulle du pseudo passe en orange (l'infobulle donne le nombre). Dès que tu lis le
  message, tout redevient normal.
  Le non-lu est repéré dans la barre de gauche : compteur à côté du pseudo, classe de type
  « unread » / « highlight », ou le sélecteur CSS que tu peux indiquer dans les options.
  La conversation ouverte n'est jamais « non lue » et quelqu'un qui vient d'écrire n'est jamais
  masqué de la liste de droite par le bouton « Masquer les whisp ». Glow et remontée se règlent
  séparément dans les options. La remontée utilise l'ordre CSS (`order`) : aucun élément de la
  page n'est déplacé ; le glow est fixe, sans animation, pour ne pas alourdir la page.
- **Détecteur d'alias** : quand un pseudo ressemble à l'un de tes pseudos tagués, un
  **anneau creux de la couleur de ce tag** apparaît à côté (infobulle : « Alias probable
  de X — 98 % », avec les raisons). Clic droit sur le pseudo → **Appliquer son tag** (le
  pseudo reçoit le même tag, avec la note « Alias de X ») ou **Ce n'est pas lui** (écarté
  pour tout le groupe d'alias). Dans le popup, le bouton **Alias** sur chaque pseudo tagué
  liste les alias possibles parmi tous les pseudos déjà vus, avec score, raisons et date.
  Le score repose sur la ressemblance des pseudos (« anais-24 » / « anais_24 », leet,
  accents, lettre en plus), le même nombre, la même ville et le même âge lus dans la
  liste des chatteurs ; un âge et une ville identiques ne suffisent jamais seuls. C'est un
  indice, jamais une preuve.
- **Infobulle** au survol de la pastille : pseudo, niveau de fiabilité et note.
- **Clic gauche sur une pastille** → rouvre le menu pour modifier le tag.
- **Popup de l'extension** : liste complète des pseudos tagués, recherche, filtres
  par couleur, édition des notes, ajout manuel, suppression, export / import JSON.
- **Page d'options** : zones d'affichage, taille de la pastille, sélecteurs CSS,
  domaines supplémentaires, gestion des données.

Les tags sont stockés dans `browser.storage.local` : rien n'est envoyé sur le réseau.

## Installation

### Test rapide (chargement temporaire)

1. Ouvre `about:debugging#/runtime/this-firefox` dans Firefox.
2. « Charger un module complémentaire temporaire… ».
3. Sélectionne le fichier `manifest.json` de ce dossier.
4. Ouvre le tchat EuropNet : les pastilles apparaissent après le chargement de la page.

L'extension temporaire disparaît à la fermeture de Firefox (les tags, eux, restent).

### Installation permanente

Firefox n'accepte les extensions non signées que sur Developer Edition, Nightly ou ESR
(avec `xpinstall.signatures.required = false` dans `about:config`). Sinon, il faut
soumettre le paquet à Mozilla (signature « self-distribution », gratuite) :

```bash
zip -r -FS ../europnet-tags.zip . -x '*.git*' 'test/*'
# puis https://addons.mozilla.org/developers/addon/submit/distribution → « On your own »
```

## Utilisation

| Action | Où |
| --- | --- |
| Taguer un pseudo | Clic droit sur le pseudo → Fiable / Prudence / À éviter |
| Ajouter une note | Champ « Note » du menu, validé par <kbd>Entrée</kbd> |
| Retirer un tag | Clic droit → « Retirer le tag » |
| Voir qui j'ai déjà whispé | Bulle bleue dans la liste des membres (conversation ouverte dans MESSAGES) |
| Voir qui m'a écrit sans que j'aie ouvert | Conversation qui brille en haut de MESSAGES (barre de gauche) |
| Trouver les alias d'un pseudo tagué | Popup → bouton « Alias » sur sa ligne (ou anneau dans le tchat) |
| Cacher ceux avec qui j'ai déjà une conversation | Bouton « Masquer les whisp » en bas de la liste des membres |
| Voir / gérer tous les tags | Icône de l'extension dans la barre d'outils |
| Sauvegarder la liste | Popup → « Exporter » (fichier JSON) |

## Performances

`node test/bench.mjs` charge une page lourde (800 chatteurs, 60 conversations, 400 messages)
avec de l'activité continue et mesure le temps passé dans les scripts : l'extension doit rester
de l'ordre de la centaine de millisecondes sur 6 secondes. Les changements de la barre de gauche
sont regroupés (150 ms) et ne redécorent que les pseudos concernés ; le glow est fixe, sans
animation sur les lignes.

## Données et vie privée

Tout reste dans le navigateur (`storage.local`) ; rien n'est envoyé ailleurs. Pour la
recherche d'alias, l'extension garde un **historique des pseudos vus** (pseudo, âge et
ville quand la liste les affiche, première / dernière vue), limité à 5 000 pseudos. Il se
désactive (case « Repérer les alias… ») et s'efface (« Effacer l'historique des pseudos
vus ») dans les options. Cet historique n'est pas inclus dans l'export JSON.

## Si aucune pastille n'apparaît

Le tchat EuropNet est dérivé de Kiwi IRC : l'extension connaît ses classes CSS
(`kiwi-messagelist-nick`, `kiwi-nicklist-user-nick`, `kiwi-statebrowser-channel-name`…)
et applique aussi des motifs génériques (`[class*="nick"]`, `[data-nick]`, …).
Si la page utilise d'autres noms de classes :

1. Ouvre le tchat, puis le popup de l'extension → bouton **Pipette**.
2. Clique sur un pseudo dans la page.
3. L'extension déduit le sélecteur CSS correspondant, l'enregistre et rafraîchit
   immédiatement l'affichage. Le sélecteur est ensuite modifiable dans les options.

Si le tchat est servi par un autre domaine que `europnet.org` (sous-domaine dédié,
autre extension de domaine…), ajoute-le dans **Options → Domaines supplémentaires**
(motif du type `*://*.exemple.org/*`), puis recharge l'onglet.

## Développement

```
manifest.json                  Manifest V3 (Firefox 115+)
src/common/store.js            Stockage partagé (tags + réglages)
src/content/content.js         Détection des pseudos, pastilles, menu, pipette, alias
src/common/alias.js            Score d'alias (module pur, partagé content script / popup)
src/content/content.css        Styles injectés dans la page
src/background/background.js   Enregistrement des domaines supplémentaires
src/popup/                     Popup de gestion de la liste
src/options/                   Page d'options
test/fixture.html              Page de test reproduisant la structure du tchat
test/run-tests.mjs             Tests d'intégration (Playwright)
```

Lancer les tests (nécessite `playwright` et un Chromium installé) :

```bash
node test/run-tests.mjs
```

Ils vérifient le nettoyage des pseudos (`Bigbi ♂`, `@Maitresse`, `%Althanea`),
l'exclusion des salons (`#BDSM`), l'affichage des pastilles dans les trois zones,
l'absence de doublons, la prise en compte des nouveaux messages, le menu du clic
droit, l'enregistrement des tags et notes, le flag « whisp » (ouverture et fermeture
d'une conversation privée, ordre pastille / flag, réglage), le filtre qui masque
les lignes de la liste (bouton, compteur, réglage des options), le score d'alias
(cas typiques, faux positifs évités, historique, panneau du popup, « Ce n'est pas lui »),
les messages non lus dans la barre de gauche (compteur, classe, sélecteur personnalisé,
conversation ouverte, glow et remontée sous le titre et avant le bouton, réglages, conversation unique)
et le mode pipette.

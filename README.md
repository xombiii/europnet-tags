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
| Voir / gérer tous les tags | Icône de l'extension dans la barre d'outils |
| Sauvegarder la liste | Popup → « Exporter » (fichier JSON) |

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
src/content/content.js         Détection des pseudos, pastilles, menu, pipette
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
droit, l'enregistrement des tags et notes, et le mode pipette.

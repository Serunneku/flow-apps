# NoteFlow — Backlog d'idées (non implémentées)

Issu de sessions de débat produit entre agents (Patrick — organisation, Théa — polish UI).
Ces idées ne sont **pas** implémentées, juste conservées pour référence future.

## Round 1 — Patrick × Théa (débat)

Patrick a proposé 7 pistes organisation ; Théa les a passées au crible design/positionnement,
en a rejeté 2, fusionné 3, et ajouté 6 des siennes. Résultat retenu (10 idées) :

**Organisation (issues du débat, 4)**
1. **Recherches enregistrées** — épingler une requête (ex: `tag:travail ET modifié<7j`) comme
   chip filtrable, plutôt qu'un nouveau type de dossier parallèle.
2. **Gestionnaire de tags global** — panneau pour renommer/fusionner des tags en masse
   (ex: unifier `#todo` et `#à-faire`).
3. **Transclusion `![[Titre]]`** — injecte le contenu d'une autre note en direct dans la note
   courante, avec un traitement visuel distinct (bordure/fond léger) pour ne pas confondre
   avec le texte natif.
4. **Scission de note réversible** — découpe une note en plusieurs à partir de ses titres H2,
   garde un lien "scindée depuis" (rétrolien) et une action d'annulation.

**Polish UI (Théa, 6)**
5. **Grain de papier réactif au thème** — texture plus visible en clair, plus feutrée en sombre.
6. **Retour haptique/sonore feutré** — petite vibration/son discret sur les moments clés
   (déverrouillage, suppression), désactivable, respecte `prefers-reduced-motion`.
7. **Animation "encre qui sèche"** sur l'indicateur de sauvegarde (radial-gradient scale+opacity).
8. **Transition "feuillet qui se soulève"** à l'ouverture d'une note depuis la liste (liste → éditeur).
9. **Curseur de plume contextuel** en mode dessin, avec pastille de couleur/taille en temps réel.
10. **Habillage doré du mode focus** — cadre discret liseré or façon "spotlight", pour que le
    mode focus se ressente comme un rituel d'écriture.

**Rejeté explicitement par Théa** (à ne pas reproposer sans nouvel angle) :
- Vue Kanban par dossier/tag — casse la métaphore carnet/papier, mauvais fit produit.
- Vue graphe des liens (nœuds/arêtes façon Obsidian) — trop froid/technique pour le ton de marque.
- Panneau "Notes apparentées" par heuristique de similarité — bruit/imprévisibilité dans un
  carnet qui se veut maîtrisé (les rétroliens explicites `[[...]]` suffisent).

## Round 2 — Patrick × Théa (débat)

Patrick a proposé 10 pistes organisation. Théa a tranché idée par idée, rejeté 1,
gardé prudemment 1 sous condition, fusionné 2 en un seul mécanisme, et ajouté 11
des siennes. Résultat retenu (20 idées) :

**Organisation (issues du débat de Patrick, 9)**
1. **Fil "revenir à…" + historique ⌘[ / ⌘]** — fusion des idées 1 et 5 de Patrick :
   un seul mécanisme d'historique de navigation contextuel (pile de positions),
   affiché comme fil d'Ariane discret, avec une épingle "revenir à…" qui n'est que
   le raccourci visuel vers le sommet de cette pile après une recherche imbriquée.
2. **Notes-sœurs par dossier partagé, tri chronologique** — gardé, à condition que
   ce soit un simple widget "autres notes de ce dossier" dans le panneau détail,
   strictement chronologique, sans aucune heuristique de similarité (distinct du
   panneau "apparentées" rejeté en round 1).
3. **Modèles de note (templates)** — gardé, classique, faible risque, forte valeur.
4. **Rappel de dossier vide/orphelin** — gardé, mais discret : badge visuel passif
   dans l'arborescence, jamais de notification poussée — le carnet ne culpabilise
   pas son utilisateur.
5. **Verrouillage de dossier entier hérité du PIN** — gardé, cohérent avec le
   verrouillage par note déjà existant, aucune nouvelle mécanique de sécurité.
6. **Vue "aujourd'hui" agrégée, lecture seule** — gardé, bon usage du streak déjà
   en place, renforce le rituel quotidien sans dupliquer les dossiers.
7. **Suggestion de wikilink par co-apparition dans un partage/export** — gardé sous
   condition stricte : suggestion ponctuelle et jamais auto-appliquée, sinon elle
   réintroduit l'esprit du panneau "apparentées" par heuristique déjà rejeté.
8. **Renommage en cascade des wikilinks, avec aperçu diff** — gardé, forte valeur,
   doit explicitement lister les notes verrouillées comme "non modifiables sans
   déverrouillage" plutôt que de les modifier silencieusement.
9. **Rejeté : espaces de travail cloisonnés / profils multi-carnets** — refusé pour
   ce round. C'est une refonte du modèle de données et de la navigation racine, pas
   un ajustement d'organisation ; hors-scope tant qu'un besoin réel de séparation
   stricte (perso/pro) n'est pas démontré par l'usage.

**Polish UI / interactions / esthétique / accessibilité (Théa, 11)**
10. **Ruban de marque-page** (S) — ruban de tissu qui indique visuellement la
    dernière position de lecture/scroll dans une note longue ; purement visuel,
    ne porte aucune logique de navigation (contrairement à l'idée 1).
11. **Tranche dorée des dossiers** (S) — l'épaisseur visuelle de la "tranche" d'un
    dossier dans la liste varie selon son nombre de notes, comme des livres sur
    une étagère.
12. **Lettrine sur note longue** (S) — première lettre du premier paragraphe en
    lettrine décorative pour les notes dépassant un seuil de longueur, activable/
    désactivable, purement typographique.
13. **Mode contraste "encre épaisse"** (M) — mode d'accessibilité distinct de
    clair/sombre : renforce les contours de texte et les séparateurs pour la
    basse vision, sans désactiver le grain de papier.
14. **Anneau de focus clavier "trombone doré"** (S) — remplace l'outline générique
    du focus clavier par une forme de trombone stylisé en fin or, cohérent avec
    la marque, visible en navigation tab.
15. **Transition "tourner la couverture"** (M) — animation d'ouverture de dossier
    distincte de la transition "feuillet qui se soulève" (round 1, réservée à
    l'ouverture de note) : effet de couverture qui pivote.
16. **Curseur d'écriture en plume** (S) — en mode texte normal (pas dessin), le
    caret clignote avec un léger halo doré au lieu de la barre verticale par
    défaut du navigateur.
17. **Annonces ARIA de marque** (M) — les actions clés (verrouillage, sauvegarde,
    déverrouillage) sont annoncées aux lecteurs d'écran avec un phrasé cohérent
    avec le ton "carnet" plutôt que des libellés techniques génériques.
18. **Poussière dorée au drag & drop** (S) — courte traînée de particules dorées
    quand une note est glissée-déposée vers un dossier, feedback de confirmation.
19. **Vignette de couverture par dossier** (M) — motif tanné choisi parmi une
    palette restreinte (5-6 textures) pour personnaliser un dossier, pas un
    système de couleurs/emoji arbitraire façon Notion.
20. **Ombre de reliure dynamique au scroll** (S) — l'ombre de reliure déjà présente
    en arrière-plan s'accentue légèrement selon la position de scroll dans la
    note, pour renforcer l'illusion de tourner les pages d'un carnet relié.

**Rejeté explicitement par Théa (round 2)** — à ne pas reproposer sans nouvel
angle :
- Espaces de travail cloisonnés / profils multi-carnets — refonte architecturale,
  pas du polish d'organisation ; à revisiter seulement si un vrai besoin de
  cloisonnement strict émerge.

## Round 3 — Patrick × Théa (débat)

Patrick a proposé 15 VRAIES nouveautés (capacités absentes, pas des
améliorations). L'utilisateur voulait exactement 10 nouveautés finales.
Théa a tranché idée par idée : 6 gardées, 9 rejetées, remplacées par 4 des
siennes pour arriver pile à 10.

**Gardées parmi les 15 de Patrick (6)**
1. **Notes vocales intégrées (MediaRecorder)** — 100% local (Blob en
   IndexedDB), aucun serveur requis.
2. **OCR photo → texte** — moteur OCR embarqué en wasm côté client, pas
   d'appel réseau.
3. **Extraction automatique de tâches depuis le texte libre** — heuristique
   locale, aucune donnée ne sort de l'appareil.
4. **Notes éphémères à durée de vie (auto-destruction)** — capacité neuve,
   zéro dépendance serveur, en plus juste pour la marque (la lettre qui
   s'efface).
5. **Scan de code-barres/QR vers note** — lecture caméra locale (lib type
   jsQR), capture une référence physique dans le carnet.
6. **Import depuis calendrier/contacts** — recadré en import de fichiers
   standards (.ics/.vcf) déposés par l'utilisateur, pas une synchronisation
   live avec l'OS (permissions natives hors scope PWA).

**Rejetées parmi les 15 de Patrick (9)** — motif principal : supposent un
vrai backend propriétaire, une dépendance cloud non déclarée, un virage
"app IA générique", ou un gadget-capteur hors ton :
- Dictée vocale continue (Web Speech API) — redondante avec les notes
  vocales, et route l'audio vers un serveur de reconnaissance cloud (Chrome).
- Géolocalisation de note + vue "notes prises ici" — gadget-capteur, hors
  ton de marque.
- Capture web via URL (façon Pocket/Instapaper) — récupérer une URL
  distante exige un scraper serveur (CORS) : backend propriétaire déguisé.
- Chiffrement de bout en bout vers un contact — un vrai E2E suppose un
  relais de clés serveur, incompatible avec "sans backend propriétaire".
- Espace collaboratif temps réel (CRDT, curseurs live) — exige un serveur
  de synchronisation permanent, et change la nature du produit (rituel
  solitaire → outil d'équipe), hors positionnement.
- Requêtes en langage naturel façon assistant IA — nécessite un LLM cloud,
  ferait basculer NoteFlow en "app IA générique".
- Publication d'une note en page web publique — "publier" suppose un
  hébergement géré par nous, hors scope sans backend propriétaire.
- Capteur d'activité physique (pas/mouvement) lié aux notes — pur
  gadget-capteur, aucun lien avec l'écriture.
- Widget d'écran d'accueil natif — un vrai widget natif exige une coquille
  native (Android/iOS), hors périmètre "PWA vanilla JS" — limite technique,
  pas produit.

**Ajoutées par Théa en remplacement (4)** — reformulent l'intention de
certaines idées rejetées de façon compatible local-first :
7. **Déverrouillage biométrique (WebAuthn / Touch ID, Face ID, empreinte)**
   — corrigé après relecture : le chiffrement réel du contenu verrouillé
   existe déjà (AES-GCM/PBKDF2, voir app.js) et n'est donc pas une
   nouveauté. La vraie capacité absente est la MÉTHODE de déverrouillage
   elle-même : aujourd'hui, seul un code PIN tapé au clavier existe. Le
   Credential Management API / WebAuthn permettrait de déverrouiller une
   note via l'authentificateur biométrique de l'appareil, sans serveur
   (les clés restent locales à l'appareil).
8. **Partage chiffré par mot de passe** — génère un fichier `.noteflow`
   chiffré (mot de passe choisi par l'utilisateur), envoyé par le canal de
   son choix (mail, message) ; remplace honnêtement l'E2E vers un contact
   sans relais serveur.
9. **Export en page web autonome** — un unique fichier HTML auto-suffisant
   (note + style + grain de papier inline) que l'utilisateur héberge où il
   veut ; remplace la "publication" sans que NoteFlow devienne un
   hébergeur.
10. **Réception de partage entrant (Web Share Target API)** — NoteFlow
    apparaît dans le menu "Partager" du système, reçoit texte/URL/sélection
    depuis n'importe quelle app sans jamais aller chercher de contenu
    distant lui-même ; remplace la capture façon Pocket sans scraping
    serveur.

**Résultat final (10 nouveautés retenues)** : Notes vocales · OCR
photo→texte · Scan QR/code-barres · Réception de partage entrant (Web
Share Target) · Extraction automatique de tâches · Notes éphémères à durée
de vie · Import .ics/.vcf · Déverrouillage biométrique (WebAuthn) ·
Partage chiffré par mot de passe · Export en page web autonome.

Fil conducteur du filtrage : toute capacité qui suppose un serveur
permanent (relais de clés, sync temps réel, LLM cloud, scraping,
hébergement, coquille native) est rejetée ou reformulée en version que
l'utilisateur héberge/transporte lui-même — cohérent avec "sync Firebase
optionnelle où l'utilisateur fournit sa propre config", jamais un backend
que NoteFlow opérerait pour lui.

## Round 4 — Théa solo (effet app premium)

Round solo, sans débat. Critère unique : est-ce que ça donne l'impression
d'utiliser une app à plus de 30 000 $ ? Aucune des 40 idées des rounds 1-3
n'est reprise, même déguisée. Vanilla JS/CSS/HTML, zéro dépendance,
zéro nouveau backend.

1. **Easing physique unifié documenté en variable CSS** (S) — une seule
   courbe `--ease-premium` (type `cubic-bezier(0.22,1,0.36,1)`) réutilisée
   sur *toutes* les transitions existantes (feuillet, couverture, menus,
   toasts) au lieu de easing par défaut du navigateur ça et là.
   *Pourquoi 30K$* : les apps bon marché ont des animations qui "arrivent
   d'un coup" ; la cohérence obsessionnelle d'une seule signature de
   mouvement partout est un détail que seuls Apple/Linear soignent.

2. **Délai de désactivation des boutons anti-double-clic avec micro-retour**
   (S) — un bouton d'action destructive/critique (supprimer, exporter) se
   désactive 400ms avec un léger assombrissement pendant l'opération réelle,
   au lieu de rester cliquable pendant l'attente réseau/async.
   *Pourquoi 30K$* : l'absence de double-soumission silencieuse est un
   signal de rigueur d'ingénierie que seuls les produits matures affichent.

3. **Son de "plume qui pose un point" à la création de note** (S) — un
   clic feutré synthétisé via `AudioContext` (pas de fichier audio), très
   bref (<80ms), désactivable, jamais avant `prefers-reduced-motion`/geste
   utilisateur.
   *Pourquoi 30K$* : un son propriétaire cohérent avec la marque au lieu
   du silence générique donne une texture sensorielle qu'on associe aux
   objets physiques haut de gamme (le clic d'un stylo Montblanc).

4. **Halo de focus qui respire (pulse très lent, 3s)** sur le champ actif
   du formulaire de verrouillage PIN (S) — au lieu d'un focus statique, un
   `box-shadow` en respiration très lente et discrète pendant la saisie.
   *Pourquoi 30K$* : un détail qu'on ne remarque qu'inconsciemment — la
   différence entre "logiciel" et "objet vivant".

5. **Numérotation de page façon livre relié** (S) — en bas de chaque note
   longue (au-delà d'un seuil), un petit folio centré "12" en petites
   capitales dorées, purement décoratif, actif seulement si la note dépasse
   une hauteur de page.
   *Pourquoi 30K$* : la pagination n'a aucune utilité fonctionnelle dans
   un carnet numérique — l'ajouter quand même est un geste "on aurait pu
   s'en passer, on ne l'a pas fait" typique du soin artisanal perçu.

6. **Vibration de confirmation à deux temps sur suppression définitive**
   (S) — `navigator.vibrate([10, 40, 10])` distinct du simple *tap* haptique
   des autres actions, pour marquer que ce geste-là est irréversible.
   *Pourquoi 30K$* : un vocabulaire haptique différencié par gravité
   d'action (au lieu d'un buzz générique unique) est un raffinement que
   seules les apps avec un budget de test UX dédié se paient.

7. **Effet de "poids" sur le drag d'une note** (S) — la carte glissée
   s'incline légèrement (2-3°) selon la vélocité du curseur pendant le
   drag, comme une feuille de papier réelle qu'on déplace trop vite.
   *Pourquoi 30K$* : c'est la même micro-physique que les listes iOS
   (l'inclinaison suit la vitesse), un des détails les plus copiés et les
   moins souvent bien exécutés du marché.

8. **Grain de papier qui suit le curseur (parallaxe subtile, 2px max)** (M)
   — la texture de fond de la page bouge très légèrement en contre-sens du
   curseur en mode focus, comme une feuille posée sur une table qu'on
   regarde sous un léger angle.
   *Pourquoi 30K$* : la parallaxe de fond est un effet réservé aux
   showcases Awwwards/produits Apple — extrêmement rare dans une app de
   productivité, et jamais dans une PWA vanilla JS.

9. **Transition de thème en "iris" partant du bouton cliqué** (M) — le
   changement clair/sombre/auto part en cercle depuis le bouton de theme
   toggle (`clip-path` circulaire animé) plutôt qu'un simple fondu global.
   *Pourquoi 30K$* : c'est littéralement l'effet qu'Android 12/Material
   You et quelques flagship apps ont rendu culte — jamais vu en PWA
   artisanale, contraste fort avec le reste du marché indé.

10. **Compteur de mots qui s'anime en "odomètre"** (S) — le nombre de mots
    en bas d'éditeur défile chiffre par chiffre (comme un compteur
    kilométrique) au lieu de sauter directement à la nouvelle valeur.
    *Pourquoi 30K$* : Apple (App Store, Wallet) et Linear utilisent cet
    effet précisément parce qu'il coûte cher à bien régler (timing par
    chiffre) — signal immédiat de budget design.

11. **Ombre portée qui suit l'angle de lumière du thème** (S) — en clair,
    l'ombre des cartes/panneaux pointe légèrement vers le bas-droit
    (lumière zénithale) ; en sombre, ombre quasi plate + léger liseré
    doré au lieu d'ombre noire, cohérent avec une "source de lumière"
    pensée plutôt que des ombres CSS par défaut.
    *Pourquoi 30K$* : la cohérence d'une direction de lumière unique dans
    tout un système d'ombres est un exercice de direction artistique que
    la plupart des apps ne font jamais.

12. **Micro-vignettage au focus mode (assombrissement des bords d'écran)**
    (S) — en entrant en mode focus, un léger vignettage radial (5-8%
    d'opacité) apparaît sur les bords de l'écran en plus du cadre doré
    existant, comme un projecteur de théâtre.
    *Pourquoi 30K$* : le vignettage cinématographique est un vocabulaire
    visuel de film/photo haut de gamme, rarement transposé à une UI
    d'app, et jamais dans un outil de notes.

13. **Curseur de texte qui s'étire légèrement pendant la frappe rapide**
    (S) — le caret (déjà personnalisé avec halo doré, round 2 idée 16)
    s'étire de quelques pixels en hauteur/opacité selon la cadence de
    frappe récente, comme un fil d'encre qui suit la main.
    *Pourquoi 30K$* : un curseur "vivant" qui réagit au rythme de frappe
    est le genre de détail que seuls les éditeurs de code haut de gamme
    (Zed) ou les claviers premium travaillent.

14. **Son distinct et très bref pour "sauvegardé" vs "erreur"** (S) —
    deux signatures sonores synthétisées différentes (accord ascendant
    discret / note grave courte) pour succès et échec de sauvegarde,
    jamais simultanées avec le retour visuel, purement redondantes pour
    le confort.
    *Pourquoi 30K$* : un langage sonore de statut cohérent (comme macOS)
    au lieu du silence ou d'un bip système générique.

15. **Alignement au pixel près du grain de papier entre les deux volets**
    (liste/éditeur) (S) — la texture de grain est calée sur une origine
    de coordonnées commune (`background-attachment` fixe par rapport au
    viewport) pour ne jamais "sauter" visuellement à la transition
    feuillet/couverture.
    *Pourquoi 30K$* : c'est un détail invisible tant qu'il est raté, et
    seulement remarqué en creux — la continuité parfaite d'une texture à
    travers une animation est un signe de relecture qualité poussée.

16. **Easter egg discret : geste "plier un coin" révèle une citation
    d'auteur sur l'écriture** (M) — un triple-tap sur le coin bas-droit
    d'une note vide révèle brièvement (2s) une citation courte sur
    l'écriture (Hemingway, Woolf...) en fondu, jamais répétitive (pool
    tournant), purement ludique.
    *Pourquoi 30K$* : les easter eggs soignés (Things 3, Craft) signalent
    qu'une équipe a du temps/budget pour du superflu assumé — signe
    classique de produit qui n'est pas sous pression de shipping permanent.

17. **Transition de suppression "page qui se froisse" au lieu d'un simple
    fade** (M) — quand une note part en corbeille depuis la liste, la
    carte se froisse légèrement (`transform: scale + skew` sur un court
    keyframe) avant de disparaître, écho visuel du geste physique de
    froisser un papier qu'on jette.
    *Pourquoi 30K$* : remplacer une suppression "générique" (fade/slide)
    par une métaphore physique cohérente avec la marque carnet est le
    genre de raffinement qu'on ne voit jamais dans les todo-apps low-cost.

18. **Bruit de fond ultra-subtil en mode focus (silence actif, pas
    musique)** (M) — option désactivable par défaut : un souffle d'air
    quasi inaudible en boucle (bruit blanc filtré très bas volume, généré
    via `AudioContext`, pas de fichier), pour donner une sensation de
    pièce habitée plutôt que de silence numérique plat.
    *Pourquoi 30K$* : le design sonore d'ambiance est un budget que
    seules les apps de productivité premium (Endel-like, Craft) engagent
    — jamais dans les apps de notes gratuites.

19. **Précision d'horodatage au survol ("il y a 3 j" devient la date/heure
    exacte au survol/appui long)** (S) — le texte relatif de la liste
    (`timeAgo`) affiche la date et l'heure exactes en tooltip natif au
    survol desktop, et en appui long sur mobile.
    *Pourquoi 30K$* : la double densité d'information (relatif visible,
    absolu disponible sur demande) est le pattern exact de Linear/Things —
    jamais implémenté dans les apps qui se contentent d'un seul format.

20. **Étalonnage des ombres et couleurs testé et corrigé pour le daltonisme
    (simulateur intégré en dev, résultat figé en prod)** (M) — pas une
    fonctionnalité visible utilisateur, mais tous les indicateurs de
    couleur actuels (couleurs de note, chips de dossier `hsl()` générées
    par hash) sont vérifiés a priori pour rester distinguables en
    deutéranopie/protanopie, avec ajustement de luminosité si besoin.
    *Pourquoi 30K$* : c'est le genre de travail invisible et coûteux en
    temps (audit systématique, pas un simple contraste WCAG) que seules
    les équipes avec un vrai budget qualité font sans qu'on le demande.

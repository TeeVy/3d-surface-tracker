# 3D Surface Tracker — prototype (phase 0)

Track une surface plane, **rectangle** (écran, étiquette, boîte…) ou **disque** (tête de
sèche-cheveux, couvercle, cadran…), et la recrée **en 3D dans After Effects** : une caméra 3D
et un null 3D collé à la surface, animés image par image.

## Installation (une seule fois)

Dans le Terminal, depuis ce dossier :

```bash
/usr/bin/python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

> Le Python de Homebrew installé sur ce Mac a un module XML cassé : on utilise celui d'Apple (`/usr/bin/python3`).
> `ffmpeg` (déjà installé) sert à lire la focale dans les métadonnées des caméras Sony.

## Panneau After Effects (recommandé)

Installation (une seule fois, puis redémarrer After Effects) :

```bash
ln -sfn "$PWD/panel" ~/Library/Application\ Support/Adobe/CEP/extensions/com.surftrack.panel
```

Le mode développeur CEP doit être activé : `defaults read com.adobe.CSXS.12 PlayerDebugMode` doit
renvoyer 1, ce qui est le cas sur ce Mac.

**Lancement** : branchez le script `ae_scripts/Tracker le calque.jsx` sur un bouton Code Runner, ou
lancez-le via *Fichier > Scripts*. Sélectionnez le calque vidéo (ou le précomp qui le contient), placez
l'instant courant sur une image où la surface est bien visible, puis cliquez le bouton. Le panneau
s'ouvre avec ce calque chargé. Seule la partie du rush visible dans la compo sera trackée.

> Le script dépose sa demande dans `~/Library/Application Support/3D Surface Tracker/`. AE doit donc
> autoriser les scripts à écrire des fichiers : *Préférences > Scripts et expressions*.
> Le bouton ↻ du panneau charge aussi le calque sélectionné.

Le panneau suit **exactement les images que montre la compo** : précomps, remappage temporel et
étirement compris (une image figée ou un ralenti sont suivis tels quels). Les images clés sont
posées sur les images de la compo.

**Seul le calque sélectionné compte**, comme avec le Camera Tracker d'AE ou Mocha :
- un **métrage** est lu directement dans son fichier ;
- un **précomp** est une boîte noire : After Effects calcule ses images (effets, stabilisation,
  remappages internes compris) et les envoie au panneau en mémoire, par le **pont STBridge** ;
- si le calque a lui-même des **effets**, le panneau refuse : précomposez-le (*Calque >
  Pré-composer*, « Déplacer tous les attributs ») puis trackez le précomp.

La focale est lue dans le rush le plus bas du précomp quand il y en a un.

### Pont After Effects (plug-in natif, une seule fois)

Le plug-in `STBridge` (code dans `native/STBridge/`) est déjà compilé dans `out/native/`. Pour
l'installer dans chaque version d'After Effects (mot de passe administrateur demandé), puis
redémarrer AE :

```bash
native/STBridge/build.sh --install
```

Il recompile au passage (SDK attendu dans `AfterEffectsSDK/`). Sans le pont, un précomp est rendu
sur disque par la file d'attente de rendu, ce qui est bien plus lent.

1. **Image de référence** : à l'ouverture, une seule lecture du plan charge les images en mémoire et
   prépare les vignettes de la timeline (bande grise). Cliquez ou glissez dans la timeline, ou
   utilisez ← → (Maj : 10 images), jusqu'à une image nette où la surface est bien visible. Avant tout
   suivi, l'image où vous relâchez devient la référence (repère jaune).
2. **Surface** :
   - **Rectangle** : cliquez les 4 coins. Le curseur d'arrondi suit les coins arrondis ; à fond, la
     forme devient un **disque**, et ⇅ inverse son inclinaison.
   - **Forme libre** : cliquez le contour d'une zone plane. Son orientation est déduite du mouvement,
     ou réglée aux anneaux en alignant la grille sur la scène (*Auto* pour revenir au mouvement).
   - **Orientation** : la grille et les axes 3D (X rouge, Y vert, Z bleu) s'affichent dès que la forme
     est fermée. Glissez un **anneau** pour tourner la surface autour de cet axe, comme dans AE. Pour
     un rectangle ou un disque, les coins suivent.
   - Vue : molette pour zoomer, Espace ou clic droit pour la déplacer, double-clic pour la recadrer.
     Glissez un point pour le corriger (une loupe s'affiche), clic droit pour le supprimer.
   - Si la vidéo n'a pas de métadonnées de focale, un champ apparaît pour la saisir.
3. **Tracker** avec les quatre boutons sous l'image : en arrière jusqu'au début, une image en
   arrière, une image en avant, en avant jusqu'à la fin. Le suivi part de l'image affichée (la
   référence ou une image déjà trackée) et s'affiche en direct ; le bouton en cours devient ■ pour
   l'arrêter. Il s'arrête aussi tout seul s'il décroche. La timeline montre les images trackées
   (vert, orange si douteux).
   - Sur une image trackée, glissez un point pour corriger la forme : la correction vaut pour tout
     le plan, la 3D est recalculée aussitôt, sans retracker.
   - Sur une surface brillante (reflets), prenez ses bords et ses coins dans la zone suivie : les
     reflets glissent quand la caméra bouge, pas les arêtes.
4. **Résultat** : la grille cyan montre la surface 3D calculée, image par image. Cochez les calques à
   créer (**Null**, **Solide**, **Texte**) puis *Créer dans AE*. Ils sont posés sur la surface et
   animés ; la caméra AE (créée une fois, puis réutilisée) reste fixe. Pour poser votre contenu,
   parentez-le au null et mettez sa position à 0,0,0.

**Annuler** : ⌘Z annule n'importe quelle action (points, arrondi, rotation, référence, suivi…),
⇧⌘Z la rétablit. Les boutons ↶ ↷ font de même. L'icône barrée efface le suivi en gardant la forme,
la corbeille efface tout.

Les fichiers de chaque session sont dans `out/panel/`, les vignettes (gardées d'une fois sur
l'autre pour un même fichier) dans `out/panel/cache/`.

## Utilisation en ligne de commande

1. **Tracker.** Une fenêtre s'ouvre sur la première image :
   - rectangle : cliquez les 4 coins dans l'ordre haut-gauche → haut-droit → bas-droit → bas-gauche ;
   - disque : cliquez 8 points ou plus sur son **bord** (l'ellipse s'affiche ; Retour arrière annule un point).

   Appuyez ensuite sur Entrée.

   ```bash
   .venv/bin/python track.py "/chemin/vers/ma_video.mp4" --pick
   .venv/bin/python track.py "/chemin/vers/ma_video.mp4" --pick --surface disc
   ```

   | Option | Effet |
   |---|---|
   | `--surface disc` | surface ronde (par défaut : `rect`) |
   | `--mode camera` | la caméra bouge et la surface est fixe. Par défaut : `object` (l'objet bouge, la caméra est fixe) |
   | `--ref-frame 40` | désigner la surface sur l'image 40 plutôt que sur la première |
   | `--focal-mm 35` | focale (équivalent plein format) si la vidéo n'a pas de métadonnées : **indispensable pour les disques** |
   | `--aspect 1.777` | rectangle : proportions réelles si vous les connaissez (ex. écran 16:9) |
   | `--smooth 6` | stabilisation de l'inclinaison, en images (défaut 2 pour un rectangle, 4 pour un disque ; 0 = aucune). Plus haut = plus stable, mais léger retard sur les rotations rapides |
   | `--flip` | disque : inverser l'inclinaison choisie automatiquement |

2. **Lire le journal.** Il indique :
   - **la focale utilisée et sa provenance.** Ordre de priorité : `--focal-mm`, puis les métadonnées
     Sony (lues automatiquement sur les fichiers originaux de la caméra), puis une estimation, puis 50 mm par défaut ;
   - **les images perdues** (flou de bougé, sortie de champ) : aucune image clé n'y est créée ;
   - **une inclinaison ambiguë** (disque, peu de perspective) : un second script
     `<nom>_AE_inclinaison_inverse.jsx` est alors exporté.

3. **Vérifier** l'aperçu `out/<nom>_apercu.mp4` :
   - le contour vert est la zone suivie ;
   - la grille cyan est la surface 3D ;
   - la flèche bleue est perpendiculaire à la surface.

4. **Dans After Effects** : ouvrez la composition qui contient la vidéo et sélectionnez le calque
   vidéo. Lancez ensuite *Fichier > Scripts > Exécuter le fichier de script…* et choisissez
   `out/<nom>_AE.jsx`, ou la variante inversée si l'inclinaison est fausse.

   Le script crée la caméra, le null « Surface (pose) » et un solide bleu de démonstration
   (avec un masque rond pour un disque). Placez votre contenu comme **enfant du null**.
   Une fenêtre affiche un contrôle de précision.

## Comment ça marche

1. **Suivi 2D** (`surftrack/tracker.py`) : seuls les pixels de la zone désignée comptent, le fond
   est ignoré. Chaque image passe par trois étapes :
   - suivi de points (KLT) ;
   - alignement dense de toute la zone sur l'image précédente (ECC), efficace même sur les surfaces peu texturées ;
   - recalage sur l'image de référence quand c'est possible, pour supprimer la dérive.
2. **Disques** (`surftrack/ellipse_track.py`) : le bord est « aimanté » sur le contour net, puis suivi
   image par image par corrélation de profils perpendiculaires au bord. Cette méthode résiste aux
   reflets mobiles et aux mains devant le bord.
3. **3D** (`surftrack/pose.py`) :
   - rectangle : ses angles droits donnent la pose (et la focale quand la perspective varie assez) ;
   - disque : l'ellipse donne directement l'inclinaison et la position, le suivi donne la rotation dans le plan.

   L'inclinaison est ensuite lissée et la position recalculée pour que la 3D reste calée sur la 2D
   (sur les coins pour un rectangle, sur le bord pour un disque).
4. **Export** (`surftrack/ae_export.py`) : le repère caméra d'OpenCV est identique à celui d'une
   caméra AE (convention vérifiée dans AE 2026), donc les poses se transcrivent directement.

## Tests

```bash
# vidéos synthétiques (rect/disc × object/camera/weak)
.venv/bin/python tools/make_synthetic.py --scenario weak --surface disc --out test_data/weak_disc
.venv/bin/python tools/evaluate.py test_data/*_rect.mp4 test_data/*_disc.mp4 --known-focal

# autotest dans After Effects : génère out/selftest/harness.jsx, à lancer dans AE
.venv/bin/python tools/ae_selftest.py --no-run
```

Précision actuelle avec une focale connue (métadonnées) :

| Cas | Inclinaison | Centre 2D |
|---|---|---|
| Rectangles (objet, caméra, faible perspective) | 0,8–1,5° | < 1 px |
| Disques (objet, caméra) | 0,5–1° | ~1 px |
| Disque en faible perspective | 0,7° si la bonne interprétation est choisie | ~1 px |

En faible perspective, le sens de l'inclinaison d'un disque est physiquement ambigu : d'où la variante exportée.

## Limites connues

- **Formes « presque rondes »** (carré très arrondi, ovale) : elles sont approximées par un disque.
- **Disques sans métadonnées** : la focale ne peut pas être estimée. Utilisez `--focal-mm`.
- **Occultation partielle** : supportée par le suivi du bord. Une occultation de la plus grande partie
  de la surface fait décrocher le suivi.
- **Vitesse** : environ 3 à 12 images par seconde selon le cas. La 4K est trackée en demi-résolution.
- **Mode caméra** : pas encore de raccord avec la caméra du Camera Tracker d'AE.
- **Phase 1** : panneau intégré à AE (tracer, tracker, appliquer sans quitter AE).

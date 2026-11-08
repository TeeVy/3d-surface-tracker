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

## Dans After Effects : effet + panneau (recommandé)

### Installation (une fois)

1. Le panneau (puis redémarrer After Effects) :

   ```bash
   ln -sfn "$PWD/panel" ~/Library/Application\ Support/Adobe/CEP/extensions/com.surftrack.panel
   ```

   Le mode développeur CEP doit être activé : `defaults read com.adobe.CSXS.12 PlayerDebugMode` doit
   renvoyer 1, ce qui est le cas sur ce Mac.
2. Les plug-ins natifs `native/` : l'effet `STEffect` et le pont `STBridge`, qui envoie au panneau les
   images calculées par After Effects, en mémoire. Mot de passe administrateur demandé, puis
   redémarrer AE :

   ```bash
   native/build.sh --install
   ```

   Le SDK d'After Effects est attendu dans `AfterEffectsSDK/` (non versionné).

### Utilisation

1. Appliquez l'effet *Effet > 3D Surface Tracker > 3D Surface Tracker* **tout en bas de la pile
   d'effets** du calque à tracker, puis cliquez **Ouvrir le tracker**. Le panneau suit l'image du
   calque **telle qu'elle arrive à l'effet** : une Stabilisation de déformation ou tout autre effet
   placé au-dessus est pris en compte, sans précomposer. Remappages et étirements du calque aussi.
   Le panneau (*Fenêtre > Extensions > 3D Surface Tracker (panneau)*) ne fonctionne qu'avec l'effet :
   sur un calque qui ne l'a pas, il propose de l'ajouter.
2. **Navigation** : sous l'image, trois groupes de boutons : suivi, clés (clé précédente, poser /
   retirer, clé suivante) et lecture (image précédente, lecture arrière, lecture, image suivante ; la
   lecture fait l'aller-retour).
   **Image de référence** : cliquez ou glissez dans la timeline (← → ; Maj : 10 images) jusqu'à une
   image nette où la surface est bien visible. Avant tout suivi, l'image où vous relâchez devient la
   référence (triangle jaune).
3. **Surface** : cliquez ses 4 coins, au plus près des vrais coins (la loupe aide) : ils donnent à la
   fois la zone suivie et le rectangle réel dont on calcule l'orientation.
   - **2D / 3D** : en 3D (par défaut), la surface prend son orientation réelle. En 2D, elle reste
     face à la caméra et ne suit que position, échelle et rotation dans l'image, comme un tracking 2D.
   - **Gizmo** : Déplacer (W), Tourner (E), Mettre à l'échelle (R), en axes **locaux** (le gizmo suit
     la surface) ou **du monde** (il fait face à la caméra) ; X bascule entre les deux. Déplacer : les
     flèches suivent un axe, le carré central fait glisser la surface dans son plan. Tourner : un
     anneau par axe. Échelle : largeur, hauteur, ou les deux avec le carré central.
   - **Arrondi** : la petite poignée près de chaque coin se glisse vers l'intérieur pour l'arrondir
     (Maj : les 4 ensemble ; double-clic : plus d'arrondi). Les 4 à fond : **disque** (⇅ inverse son
     inclinaison).
   - Glissez un **coin**, ou un **côté** pour déplacer ses deux coins d'un bloc.
   - Vue : molette pour zoomer, Espace ou clic droit pour la déplacer, double-clic pour recadrer.
4. **Tracker** avec les boutons sous l'image : en arrière jusqu'au bout, une image en arrière, en
   avant **puis** en arrière, une image en avant, en avant jusqu'au bout. Le suivi part de l'image
   affichée et s'arrête à la **clé** suivante, au bout du calque, ou s'il décroche ; le bouton en cours
   devient ■ pour l'arrêter.
5. **Corriger** : si la forme dérive sur une image, retouchez-la (coins, côtés, gizmo) : ça pose une
   **clé** (◆ dans la timeline). La forme y est imposée et le suivi est corrigé progressivement entre
   les clés voisines. Vous pouvez aussi retracker depuis la clé jusqu'à la clé suivante. Le bouton ◆
   pose une clé sur l'image affichée ; pour en retirer une : ◆, Suppr, ou clic droit sur son losange.
   Les clés sont enregistrées avec le tracking (sous-groupe « Corrections » de l'effet : une image
   clé par clé, qui porte sa correction) : en rouvrant le tracker, on retrouve le suivi brut
   et les clés par-dessus, et retirer une clé annule bien sa correction.
6. **Appliquer le tracking** : la pose est écrite en images clés dans l'effet. C'est le seul
   enregistrement : le tracking appartient à l'effet. En rouvrant le tracker, il est reconstruit à
   partir de ses données (les corrections faites par clés y sont déjà intégrées) ; ce qui n'a pas été
   appliqué est perdu à la fermeture du panneau.

**L'effet**, dans l'ordre : *Tracker* (ouvrir le panneau), *Afficher la grille* (grille 3D dans la
fenêtre de composition quand l'effet est sélectionné), *Données du tracking* (seules la position et
l'orientation sont animées, et le zoom si l'objectif zoome ; le reste décrit la surface, la caméra,
le mode 2D/3D et l'image de référence),
*Créer* : cochez Texte et/ou Solide (Caméra et Calque nul le sont toujours), puis **Créer les
calques**. Le null reçoit une copie des images clés de la pose ; le texte et le solide lui sont
parentés. Après un nouveau tracking appliqué, recréez les calques.

**Annuler** : ⌘Z annule n'importe quelle action du panneau, ⇧⌘Z la rétablit. La corbeille propose
d'effacer le suivi seul (la forme reste) ou tout.

**Pour un bon tracking** : placez les coins sur les vrais coins de la surface plutôt qu'un peu en
dehors (le fond qui bouge autrement que la surface fausse le suivi) ou trop à l'intérieur (les bords
sont ce qui se suit le mieux) ; quelques pixels de débord sont tolérés. Choisissez une référence nette,
où la surface est grande et bien visible. Sur une surface brillante, ce sont les arêtes qui comptent :
les reflets glissent quand la caméra bouge.

Les images de chaque session (vignettes, images en pleine résolution) sont dans `out/panel/`.

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

# moteur du panneau sans After Effects : un faux pont sert les images d'une vidéo
.venv/bin/python tools/fake_bridge.py test_data/object_rect.mp4 /tmp/st.sock &
ST_BRIDGE_SOCK=/tmp/st.sock .venv/bin/python engine.py session SEQ.json out/thumbs
```

Précision actuelle avec une focale connue (métadonnées) :

| Cas | Inclinaison | Centre 2D |
|---|---|---|
| Rectangles (objet, caméra, faible perspective) | 0,8–1,5° | < 1 px |
| Disques (objet, caméra) | 0,5–1° | ~1 px |
| Disque en faible perspective | 0,7° si la bonne interprétation est choisie | ~1 px |

En faible perspective, le sens de l'inclinaison d'un disque est physiquement ambigu : d'où la variante exportée.

## Limites connues

- **Disques sans métadonnées** : la focale ne peut pas être estimée ; saisissez-la dans le panneau
  (ou `--focal-mm` en ligne de commande).
- **Arrondis** : ils sont définis dans le carré unité du rectangle ; sur un rectangle très allongé, les
  coins arrondis sont légèrement elliptiques.
- **Occultation partielle** : supportée par le suivi du bord. Une occultation de la plus grande partie
  de la surface fait décrocher le suivi.
- **Vitesse** : environ 3 à 12 images par seconde selon le cas. La 4K est trackée en demi-résolution.
- **Caméra** : la caméra créée est fixe et la surface animée ; pas encore de raccord avec la caméra du
  Camera Tracker d'AE.

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

Le panneau s'ouvre via *Fenêtre > Extensions > 3D Surface Tracker*. Il faut que le mode développeur
CEP soit activé (`defaults read com.adobe.CSXS.12 PlayerDebugMode` doit renvoyer 1, ce qui est le cas sur ce Mac).

1. **Plan** : dans la compo, sélectionnez le calque vidéo (ou le précomp qui le contient) et placez
   l'instant courant sur une image où la surface est bien visible, puis cliquez *Charger le calque
   sélectionné*. Seule la partie du rush visible dans la compo sera trackée (modifiable dans les
   réglages avancés).
2. **Surface** : choisissez un outil dans la barre, puis cliquez sur l'image :
   - *Rectangle* : les 4 coins (écran, étiquette, boîte) ;
   - *Disque* : des points sur le bord (couvercle, tête ronde) ;
   - *Forme libre* : le contour d'une zone plane quelconque. Son orientation est déduite du
     mouvement, il faut donc que la caméra ou l'objet se déplace un peu.

   Pour ajuster :
   - molette pour zoomer, Espace ou clic droit pour déplacer la vue ;
   - glissez un point pour le corriger (une loupe s'affiche) ;
   - clic droit sur un point pour le supprimer.
3. **Tracker** : le suivi s'affiche en direct. *Arrêter et garder* stoppe dès que ça décroche, en
   conservant les images déjà trackées. Le moteur détecte aussi qui bouge (l'objet ou la caméra), ce
   qui décide de ce qui est animé dans AE. Le mode peut être forcé dans les réglages avancés.
4. **Résultat** : parcourez l'aperçu (l'instant d'AE suit). Si l'inclinaison est ambiguë, comparez avec
   *Inclinaison inversée*. Cliquez ensuite *Appliquer dans After Effects*.

Les fichiers de chaque session sont dans `out/panel/`.

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

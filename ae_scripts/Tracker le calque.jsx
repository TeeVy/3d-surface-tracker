// 3D Surface Tracker — ouvre le panneau avec le calque sélectionné déjà chargé.
// À brancher sur un bouton Code Runner (ou Fichier > Scripts > Exécuter le fichier de script…).
// Le calque peut être une vidéo ou un précomp qui en contient une.
(function () {
    var TITLE = "3D Surface Tracker";
    var MENU = "3D Surface Tracker (panneau)";  // différent du nom de l'effet, sinon AE applique l'effet
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem) || comp.selectedLayers.length === 0) {
        alert(TITLE + "\n\nSélectionnez d'abord le calque à tracker dans une composition.");
        return;
    }
    var L = comp.selectedLayers[0];

    // Le panneau récupère la demande dans ce dossier (~/Library/Application Support/3D Surface Tracker).
    var dir = new Folder(Folder.userData.fsName + "/" + TITLE);
    try {
        if (!dir.exists) dir.create();
        var f = new File(dir.fsName + "/pending.json");
        f.encoding = "UTF-8";
        if (!f.open("w")) throw new Error("écriture impossible");
        f.write('{"compId":' + comp.id + ',"layerIndex":' + L.index + ',"time":' + comp.time +
                ',"stamp":' + new Date().getTime() + '}');
        f.close();
    } catch (e) {
        alert(TITLE + "\n\nImpossible d'écrire la demande pour le panneau.\n" +
              "Activez : Préférences > Scripts et expressions > « Autoriser les scripts à écrire des fichiers et à accéder au réseau ».");
        return;
    }

    // Panneau déjà ouvert ? Il met à jour alive.txt chaque seconde : on ne le rouvre pas
    // (la commande de menu fermerait un panneau ouvert).
    var alive = new File(dir.fsName + "/alive.txt"), isOpen = false;
    if (alive.exists && alive.open("r")) {
        var t = parseFloat(alive.read());
        alive.close();
        isOpen = (new Date().getTime() - t) < 3000;
    }
    if (!isOpen) {
        var id = app.findMenuCommandId(MENU);
        if (id) app.executeCommand(id);
        else alert(TITLE + "\n\nOuvrez le panneau : Fenêtre > Extensions > " + TITLE + ".\nLe calque y sera chargé automatiquement.");
    }
})();

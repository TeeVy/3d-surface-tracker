"""Test de bout en bout DANS After Effects.

Pour chaque vidéo synthétique et chaque ordre de rotation candidat, génère un
.jsx, le fait exécuter par AE (via AppleScript) dans une compo temporaire, et
récupère l'erreur de reprojection mesurée par AE lui-même. Tout ce qui est créé
dans le projet est supprimé à la fin.

Usage : .venv/bin/python tools/ae_selftest.py [--app "Adobe After Effects 2026"] [--no-run]
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import surftrack.ae_export as ae  # noqa: E402
from surftrack.pipeline import run  # noqa: E402
from surftrack.surface import DiscSurface, RectSurface  # noqa: E402

HARNESS = r"""
(function () {
    var cases = __CASES__;
    var out = [];
    for (var i = 0; i < cases.length; i++) {
        var c = cases[i];
        var io = new ImportOptions(File(c.video));
        var footage = app.project.importFile(io);
        var comp = app.project.items.addComp("ST_selftest", footage.width, footage.height, 1,
                                             footage.duration, footage.frameRate);
        var L = comp.layers.add(footage);
        comp.openInViewer();
        L.selected = true;
        $.global.ST_TEST_MODE = true;
        $.global.ST_TEST_RESULT = null;
        try {
            $.evalFile(File(c.jsx));
            var r = $.global.ST_TEST_RESULT;
            out.push(c.label + " => moyenne " + r.mean.toFixed(3) + " px, max " + r.max.toFixed(3) + " px");
        } catch (e) {
            out.push(c.label + " => ERREUR " + e.toString() + " ligne " + e.line);
        }
        var solids = [];
        for (var j = 1; j <= comp.numLayers; j++) {
            var src = comp.layer(j).source;
            if (src && src instanceof FootageItem && src.mainSource instanceof SolidSource) solids.push(src);
        }
        comp.remove();
        for (var s = 0; s < solids.length; s++) solids[s].remove();
        footage.remove();
    }
    $.global.ST_TEST_MODE = false;
    var txt = out.join("\n");
    if (__ALERT__) alert("3D Surface Tracker - autotest\n\n" + txt);
    return txt;
})();
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="Adobe After Effects 2026")
    ap.add_argument("--orders", default="xyz")
    ap.add_argument("--no-run", action="store_true", help="génère seulement harness.jsx (à lancer à la main dans AE)")
    args = ap.parse_args()

    outdir = ROOT / "out" / "selftest"
    outdir.mkdir(parents=True, exist_ok=True)
    cases = []
    for name, mode in (("object_rect", "object"), ("camera_rect", "camera"), ("object_disc", "object"),
                       ("weak_disc", "camera")):
        video = ROOT / "test_data" / f"{name}.mp4"
        gt = json.loads((ROOT / "test_data" / f"{name}_gt.json").read_text())
        fr = gt["frames"][0]
        surface = DiscSurface(np.array(fr["rim"])[::3]) if gt["surface"] == "disc" else RectSurface(fr["corners"])
        res = run(video, surface, 0, focal_px=gt["focal"], log=lambda *_: None)
        for order in args.orders.split(","):
            ae.AE_EULER_ORDER = order
            jsx = outdir / f"{name}_{order}.jsx"
            ae.write_jsx(jsx, ae.build_ae_data(res, mode), name="ST test")
            cases.append({"label": f"{name:11s} {mode:6s} ordre {order}", "video": str(video), "jsx": str(jsx)})
        print(f"{name} : JSX généré")

    harness = outdir / "harness.jsx"
    js = HARNESS.replace("__CASES__", json.dumps(cases)).replace("__ALERT__", "true" if args.no_run else "false")
    harness.write_text(js, encoding="utf-8")
    if args.no_run:
        print(f"Dans After Effects : Fichier > Scripts > Exécuter le fichier de script… > {harness}")
        return
    script = f'tell application "{args.app}" to DoScriptFile "{harness}"'
    res = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=900)
    print(res.stdout.strip() or res.stderr.strip())


if __name__ == "__main__":
    main()

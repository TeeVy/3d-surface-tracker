"""Moteur du panneau After Effects.

    engine.py session SEQ.json THUMBS_DIR

Garde en mémoire les images du calque tracké (envoyées par After Effects via le pont
STBridge) et répond aux commandes du panneau : voir surftrack/session.py. Toutes les
sorties sur stdout sont des lignes JSON ({"type": ...}).
"""

import argparse
import sys
import traceback

from surftrack.session import emit, run_session


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("session")
    p.add_argument("seq", help="JSON : instants des images, calque, dimensions, rush pour la focale")
    p.add_argument("thumbs_dir")
    a = ap.parse_args()
    try:
        run_session(a.seq, a.thumbs_dir)
    except Exception as e:  # le panneau affiche le message
        emit(type="error", msg=str(e), trace=traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()

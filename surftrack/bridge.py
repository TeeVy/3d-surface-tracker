"""Client du pont After Effects (plug-in natif STBridge, voir native/STBridge).

After Effects calcule l'image d'un calque juste avant un de ses effets, à un instant
donné, et l'envoie en mémoire par une connexion locale (127.0.0.1) : pas de fichiers,
pas de file de rendu. Le port et le jeton sont dans bridge.json, écrit par le pont.
"""

import json
import os
import socket
import sys
from fractions import Fraction

import numpy as np


def info_path():
    if os.environ.get("ST_BRIDGE_INFO"):
        return os.environ["ST_BRIDGE_INFO"]
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    else:
        base = os.path.expanduser("~/Library/Application Support")
    return os.path.join(base, "3D Surface Tracker", "bridge.json")


class BridgeError(IOError):
    pass


class Bridge:
    def __init__(self, path=None, timeout=120.0):
        try:
            with open(path or info_path(), encoding="utf-8") as f:
                info = json.load(f)
            self.s = socket.create_connection(("127.0.0.1", int(info["port"])), timeout=timeout)
            self.s.sendall(f"AUTH {info['token']}\n".encode())
        except (OSError, ValueError, KeyError) as e:
            raise BridgeError("After Effects bridge not found (STBridge plug-in not installed, or AE closed).") from e
        self.s.settimeout(timeout)
        self.buf = b""

    def _line(self):
        while b"\n" not in self.buf:
            chunk = self.s.recv(65536)
            if not chunk:
                raise BridgeError("The After Effects bridge closed the connection.")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode("utf-8", "replace")

    def _exact(self, n):
        out = bytearray(self.buf[:n])
        self.buf = self.buf[n:]
        while len(out) < n:
            chunk = self.s.recv(min(1 << 22, n - len(out)))
            if not chunk:
                raise BridgeError("Incomplete frame received from the After Effects bridge.")
            out += chunk
        return bytes(out)

    def ping(self):
        self.s.sendall(b"PING\n")
        return self._line().startswith("OK")

    def render_layer(self, comp, layer, effect, t, downsample=1, color=True):
        """Image du calque n° layer de la compo `comp`, juste avant son effet n° effect (numéros
        ExtendScript), à l'instant t (secondes) de la compo : BGR (h,w,3) ou gris (h,w)."""
        fr = Fraction(t).limit_denominator(1_000_000)
        if fr.numerator > 2**31 - 1:  # A_Time sur 32 bits
            fr = Fraction(round(float(t) * 1000), 1000)
        self.s.sendall(f"RENDERL {int(comp)} {int(layer)} {int(effect)} {fr.numerator} {fr.denominator} "
                       f"{int(downsample)} {'C' if color else 'G'}\n".encode())
        head = self._line()
        if not head.startswith("OK"):
            raise BridgeError("After Effects : " + head[4:])
        _, w, h, ch = head.split()
        w, h, ch = int(w), int(h), int(ch)
        data = np.frombuffer(self._exact(w * h * ch), np.uint8)
        return data.reshape(h, w, ch) if ch == 3 else data.reshape(h, w)

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass

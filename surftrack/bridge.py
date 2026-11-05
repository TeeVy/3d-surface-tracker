"""Client du pont After Effects (plug-in natif STBridge, voir native/STBridge).

After Effects calcule l'image d'un élément du projet (précomp ou métrage) à un instant
donné et l'envoie en mémoire par une socket locale : pas de fichiers, pas de file de rendu.
"""

import os
import socket
from fractions import Fraction

import numpy as np

SOCK = os.environ.get("ST_BRIDGE_SOCK") or os.path.expanduser("~/Library/Application Support/3D Surface Tracker/bridge.sock")


class BridgeError(IOError):
    pass


class Bridge:
    def __init__(self, path=SOCK, timeout=120.0):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.settimeout(timeout)
        try:
            self.s.connect(path)
        except OSError as e:
            raise BridgeError("Pont After Effects absent (plug-in STBridge non installé ou AE fermé).") from e
        self.buf = b""

    def _line(self):
        while b"\n" not in self.buf:
            chunk = self.s.recv(65536)
            if not chunk:
                raise BridgeError("Le pont After Effects a fermé la connexion.")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode("utf-8", "replace")

    def _exact(self, n):
        out = bytearray(self.buf[:n])
        self.buf = self.buf[n:]
        while len(out) < n:
            chunk = self.s.recv(min(1 << 22, n - len(out)))
            if not chunk:
                raise BridgeError("Image incomplète reçue du pont After Effects.")
            out += chunk
        return bytes(out)

    def ping(self):
        self.s.sendall(b"PING\n")
        return self._line().startswith("OK")

    def render(self, item, t, downsample=1, color=True):
        """Image de l'élément `item` (id AE) à l'instant t (secondes) : BGR (h,w,3) ou gris (h,w)."""
        fr = Fraction(t).limit_denominator(1_000_000)
        if fr.numerator > 2**31 - 1:  # A_Time sur 32 bits
            fr = Fraction(round(float(t) * 1000), 1000)
        self.s.sendall(f"RENDER {int(item)} {fr.numerator} {fr.denominator} {int(downsample)} "
                       f"{'C' if color else 'G'}\n".encode())
        return self._read_image()

    def render_layer(self, comp, layer, effect, t, downsample=1, color=True, layer_time=True):
        """Image du calque n° layer de la compo `comp`, juste avant son effet n° effect (numéros
        ExtendScript), à l'instant t de la compo."""
        fr = Fraction(t).limit_denominator(1_000_000)
        if fr.numerator > 2**31 - 1:
            fr = Fraction(round(float(t) * 1000), 1000)
        self.s.sendall(f"RENDERL {int(comp)} {int(layer)} {int(effect)} {fr.numerator} {fr.denominator} "
                       f"{int(downsample)} {'C' if color else 'G'} {'L' if layer_time else 'C'}\n".encode())
        return self._read_image()

    def _read_image(self):
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


def available(path=SOCK):
    try:
        b = Bridge(path, timeout=3)
        ok = b.ping()
        b.close()
        return ok
    except (OSError, BridgeError):
        return False

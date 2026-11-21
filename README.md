# 3D Surface Tracker

A planar tracker for **After Effects** with **3D output**. Track a flat surface — a
**rectangle** (screen, label, box…) or a **disc** (lid, dial, round button…) — like you would
in Mocha, and get a 3D camera plus a 3D null stuck to the surface, ready to parent your
content to.

- Works on the layer **as it reaches the effect**: stabilization or any effect placed above
  it is taken into account, no need to precompose. Time remapping and stretch too.
- Frames are rendered by After Effects and streamed in memory to the tracker: no render
  queue, no proxy files.
- Corner keys to fix drift, like Mocha; they also act as templates so the tracker drifts less.
- 3D (full orientation) or 2D (position, scale, rotation) solve.
- One click creates a camera, null, text, solid and/or shape layer that follow the tracking
  — and update when you apply a new track.
- English or French interface.

## Install

Download the package for your system from the
[Releases](https://github.com/TeeVy/3d-surface-tracker/releases) page and unzip it.

**macOS** (Apple Silicon and Intel, After Effects 2023 or later)

1. Right-click `install-mac.command` > **Open** (the first time macOS asks for confirmation,
   because the script is not signed). Your administrator password is requested to copy the
   plug-ins into Adobe's shared plug-in folder.
2. Restart After Effects.

**Windows** (After Effects 2023 or later, x64)

1. Right-click `install-windows.bat` > **Run as administrator**.
2. Restart After Effects.

Then, once, in After Effects: *Settings > Scripting & Expressions* > tick **Allow Scripts to
Write Files and Access Network** (the effect's button uses it to hand the layer to the panel).

<details>
<summary>What the installer does (manual install)</summary>

| What | macOS | Windows |
|---|---|---|
| `plugins/` (effect + bridge) | `/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/3D Surface Tracker/` | `C:\Program Files\Common Files\Adobe\Common\Plug-ins\7.0\MediaCore\3D Surface Tracker\` |
| `extension/` (panel + engine) | `~/Library/Application Support/Adobe/CEP/extensions/com.surftrack.panel/` | `%APPDATA%\Adobe\CEP\extensions\com.surftrack.panel\` |
| Unsigned panels allowed | `defaults write com.adobe.CSXS.<9…14> PlayerDebugMode 1` | registry `HKCU\Software\Adobe\CSXS.<9…14>`, `PlayerDebugMode` = `1` |

On macOS, files downloaded from the internet are quarantined: the installer clears that flag
(`xattr -dr com.apple.quarantine`). To uninstall on macOS, run `uninstall-mac.command`; on
Windows, delete the two folders above.
</details>

Optional: with [ffmpeg](https://ffmpeg.org) installed (`brew install ffmpeg` on macOS), the
focal length is read from Sony camera metadata. Otherwise it is estimated from the
perspective, or you can type it in.

## How to use

1. Apply **Effect > TeeVy > 3D Surface Tracker** at the **bottom of the effect stack** of the
   layer to track, then click **Open tracker**.
2. Go to a sharp frame where the surface is clearly visible and click its **4 corners**
   (rounding handles near the corners turn it into a rounded rectangle or a disc).
3. **Track** forward and/or backward. If the shape drifts, fix it on that frame: this sets a
   **key** and the track is corrected up to the neighbouring keys.
4. **Apply tracking**: the result is written into the effect (that is the only save).
5. In the effect, tick what you need under **Create** and click **Create layers**.

The **?** button in the panel lists everything else (shortcuts, keys, 2D/3D, playback).

Tips for a good track: put the corners on the real corners of the surface, pick a sharp
reference frame where the surface is large, and on glossy surfaces rely on edges (reflections
slide when the camera moves).

## How it works

- **Bridge** (`native/STBridge`, AEGP plug-in): renders the layer just upstream of the effect
  on After Effects' main thread and serves the pixels over a local connection (127.0.0.1, a
  random port and a secret token stored in a file only the user can read).
- **Effect** (`native/STEffect`): holds the tracking data as keyframes, draws the 3D grid in
  the comp window, opens the panel and creates the layers.
- **Panel** (`panel/`, CEP): the tracker UI. It drives the engine and writes the result into
  the effect.
- **Engine** (`engine.py`, `surftrack/`, Python + OpenCV, shipped as a standalone program):
  - 2D tracking (`tracker.py`): feature points, then dense alignment of the whole area (ECC)
    on the previous frame, then on the nearest key or the reference to remove drift; pixels
    that stop matching (a hand passing in front…) are excluded and the alignment is redone.
  - Discs (`ellipse_track.py`): the rim is snapped to the sharp contour and followed with
    edge profiles, which resists reflections and hands over the rim.
  - 3D (`pose.py`): a rectangle's right angles give its pose (and the focal length when the
    perspective varies enough); a disc's ellipse gives its tilt (two interpretations: the ⇅
    button flips between them).

## Build from source

Requirements: the After Effects SDK (from Adobe's developer site, not included) unzipped in
`AfterEffectsSDK/`.

**macOS** (Xcode command line tools):

```bash
native/build.sh                      # plug-ins -> out/native (add --install to copy them into AE)
packaging/build_engine.sh arm64      # standalone engine -> out/engine/arm64 (x86_64 for Intel)
packaging/make_release_mac.sh        # package -> out/release/3D-Surface-Tracker-<version>-mac.zip
```

The engine is built with a minimal OpenCV compiled from source (core, imgproc, video,
calib3d, imgcodecs; no video codecs), see `packaging/build_engine.sh`.

**Windows**: `packaging\build_windows.bat` from an *x64 Native Tools Command Prompt for
VS 2022* (plug-ins, engine and package). It has not been tested on Windows yet.

**Development** (panel from the repository, Python engine run from source):

```bash
/usr/bin/python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
ln -sfn "$PWD/panel" ~/Library/Application\ Support/Adobe/CEP/extensions/com.surftrack.panel
```

Without a bundled engine in `panel/engine/`, the panel runs `engine.py` with `.venv`.

Tests without After Effects: `tools/fake_bridge.py` serves the frames of a video with the
bridge protocol; `tools/make_synthetic.py` and `tools/evaluate.py` measure the accuracy on
synthetic videos.

## Support

If this tool saves you time, you can [support me on Ko-fi](https://ko-fi.com/robincarlo) ☕

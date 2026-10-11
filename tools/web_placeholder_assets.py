#!/usr/bin/env python3
"""Write placeholder menu images into port/web/assets/ui.

The browser page's menu art (map thumbnails, mode icons, armor previews,
shell decoration) is not in Git: the repository keeps every assets folder
out. A deployment without the original art can run this to get plain,
correctly named images so the build and the page work. Existing files are
left alone, so real art placed there wins.

Placeholders are for local builds only. Each one carries MARKER, and
tools/web_stage_cloudflare.py refuses to stage a deployment that holds any
placeholder (marked, or byte-identical to an older unmarked one).
"""

from __future__ import annotations

import functools
import struct
import sys
import zlib
from pathlib import Path

MAPS = {
    "battle-creek": (70, 110, 60), "sidewinder": (150, 160, 175), "damnation": (90, 85, 70),
    "rat-race": (80, 90, 100), "prisoner": (170, 180, 195), "hang-em-high": (120, 100, 70),
    "chill-out": (60, 120, 150), "derelict": (70, 60, 90), "boarding-action": (60, 70, 85),
    "blood-gulch": (110, 130, 70), "wizard": (100, 80, 130), "chiron-tl-34": (130, 120, 110),
    "longest": (110, 70, 60),
}
MODES = {
    "slayer": (180, 60, 50), "team-slayer": (60, 100, 180), "capture-the-flag": (200, 160, 40),
    "oddball": (230, 230, 230), "king-of-the-hill": (200, 120, 40), "race": (60, 170, 90),
}
MARKER = b"halo-web-placeholder"

ARMOR = {
    "white": (225, 225, 225), "black": (40, 40, 45), "red": (190, 40, 40), "blue": (40, 70, 190),
    "sage": (110, 130, 95), "yellow": (220, 200, 50), "lime": (140, 210, 60), "pink": (230, 130, 180),
    "purple": (120, 60, 160), "cyan": (60, 200, 210), "cornflower": (100, 140, 230),
    "orange": (230, 130, 40), "teal": (40, 140, 130), "forest": (40, 90, 50), "brown": (110, 75, 45),
    "tan": (190, 165, 120), "maroon": (110, 30, 40), "rose": (200, 90, 110),
}


def png(width: int, height: int, pixel, marked: bool = True) -> bytes:
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    text = chunk(b"tEXt", b"Comment\x00" + MARKER) if marked else b""
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + text + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


def gradient(color, width, height, marked=True):
    def pixel(x, y):
        shade = 0.65 + 0.35 * (1 - y / height)
        return bytes((min(255, int(c * shade)) for c in color)) + b"\xff"
    return png(width, height, pixel, marked)


def spartan(color, size=192, marked=True):
    """A visor-shaped silhouette in the armor color on transparency."""
    def pixel(x, y):
        cx, cy = x - size / 2, y - size * 0.55
        body = (cx / (size * 0.32)) ** 2 + (cy / (size * 0.42)) ** 2 <= 1
        visor = abs(cx) < size * 0.18 and -size * 0.22 < cy < -size * 0.1
        if visor:
            return bytes((200, 160, 40, 255))
        if body:
            shade = 0.7 + 0.3 * (1 - y / size)
            return bytes(min(255, int(c * shade)) for c in color) + b"\xff"
        return b"\x00\x00\x00\x00"
    return png(size, size, pixel, marked)


# A JPEG decoder accepts no PNG, so the menu backdrop is a tiny real JPEG:
# a single dark blue 8x8 block.
MENU_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432"
    "ffc0000b080008000801011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9"
)


def placeholder_images(marked: bool = True) -> dict[str, bytes]:
    """Every placeholder, keyed by its path under port/web/assets/ui."""
    return dict(_placeholder_images(marked))


@functools.cache
def _placeholder_images(marked: bool) -> dict[str, bytes]:
    images: dict[str, bytes] = {}
    for name, color in MAPS.items():
        images[f"maps/{name}.png"] = gradient(color, 160, 90, marked)
    for name, color in MODES.items():
        images[f"modes/{name}.png"] = gradient(color, 64, 64, marked)
    for name, color in ARMOR.items():
        images[f"spartan/{name}.png"] = spartan(color, marked=marked)
    clear = png(4, 4, lambda x, y: b"\x00\x00\x00\x00", marked)
    images["shell/hud-frame.png"] = clear
    images["shell/kofi-support-dark.png"] = clear
    images["shell/xbox-duke-controller.png"] = gradient((40, 60, 50), 320, 200, marked)
    # a JPEG comment segment (FFFE) right after the start-of-image marker
    comment = b"\xff\xfe" + (len(MARKER) + 2).to_bytes(2, "big") + MARKER
    images["shell/halo-ce-ring-menu.jpg"] = MENU_JPEG[:2] + comment + MENU_JPEG[2:] if marked else MENU_JPEG
    svg_comment = b"<!--" + MARKER + b"-->" if marked else b""
    images["shell/mitchell-jester-card.svg"] = (
        b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' + svg_comment + b"</svg>"
        if marked
        else b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    )
    return images


def placeholder_files(ui_assets: Path) -> list[Path]:
    """The files under ui_assets that are placeholders rather than real art."""
    legacy = set(placeholder_images(marked=False).values())
    found = []
    for path in sorted(p for p in ui_assets.rglob("*") if p.is_file()):
        data = path.read_bytes()
        if MARKER in data or data in legacy:
            found.append(path)
    return found


def main() -> int:
    root = Path(__file__).resolve().parents[1] / "port" / "web" / "assets" / "ui"
    written: list[Path] = []
    for name, data in placeholder_images().items():
        path = root / name
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        written.append(path)
    print(f"wrote {len(written)} placeholder images under {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

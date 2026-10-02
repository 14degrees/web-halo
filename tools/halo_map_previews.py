#!/usr/bin/env python3
"""Exports Halo's own multiplayer map-select pictures for the web landing.

    python3 tools/halo_map_previews.py assets/maps/ui.map port/web/assets/ui/maps/preview

The Xbox ui.map is zlib-compressed after its 2 KB header. Its bitmap
ui\\shell\\bitmaps\\mp_map_grafix holds one 256x128 DXT1 picture per map
(the picture itself is about 140x115, top left), in the order of the game's
map list (port/web/online_client.js MAP_SLUGS). Each map gets <slug>.png
(the picture) and <slug>-large.jpg (upscaled and softened, the landing's
backdrop).
"""

import io
import os
import struct
import sys
import zlib

from PIL import Image, ImageFilter

SLUGS = ["battle-creek", "sidewinder", "damnation", "rat-race", "prisoner", "hang-em-high", "chill-out",
         "derelict", "boarding-action", "blood-gulch", "wizard", "chiron-tl-34", "longest"]
TAG = "ui\\shell\\bitmaps\\mp_map_grafix"


def load(path: str) -> bytes:
    raw = open(path, "rb").read()
    return raw[:0x800] + zlib.decompress(raw[0x800:])


def find_bitmap(data: bytes, name: str) -> tuple[int, int]:
    index, = struct.unpack_from("<I", data, 0x10)
    tags_pointer, _, _, count = struct.unpack_from("<IIII", data, index)
    base = tags_pointer - (index + 0x24)
    for i in range(count):
        entry = index + 0x24 + i * 32
        group = data[entry:entry + 4][::-1]
        name_pointer, data_pointer = struct.unpack_from("<II", data, entry + 16)
        start = name_pointer - base
        if group == b"bitm" and data[start:data.index(b"\0", start)].decode("latin1") == name:
            return data_pointer - base, base
    raise SystemExit(f"{name} not found")


def dds(width: int, height: int, pixels: bytes) -> bytes:
    header = struct.pack("<4sIIIIIII44sIIII16sIIIII", b"DDS ", 124, 0x81007, height, width, len(pixels), 0, 1,
                         b"\0" * 44, 32, 0x4, 0x31545844, 0, b"\0" * 16, 0x1000, 0, 0, 0, 0)
    return header + pixels


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    data = load(sys.argv[1])
    os.makedirs(sys.argv[2], exist_ok=True)
    tag, base = find_bitmap(data, TAG)
    count, pointer = struct.unpack_from("<II", data, tag + 0x60)
    for i, slug in enumerate(SLUGS[:count]):
        entry = pointer - base + i * 0x30
        width, height = struct.unpack_from("<HH", data, entry + 4)
        offset, size = struct.unpack_from("<II", data, entry + 0x18)
        image = Image.open(io.BytesIO(dds(width, height, data[offset:offset + size]))).convert("RGB")
        pixels = image.load()
        right = max(x for x in range(width) for y in range(0, height, 4) if sum(pixels[x, y]) > 12) + 1
        bottom = max(y for y in range(height) for x in range(0, right, 4) if sum(pixels[x, y]) > 12) + 1
        picture = image.crop((0, 0, right, bottom))
        picture.save(os.path.join(sys.argv[2], f"{slug}.png"))
        large = picture.resize((picture.width * 8, picture.height * 8), Image.LANCZOS)
        large.filter(ImageFilter.GaussianBlur(1.2)).save(os.path.join(sys.argv[2], f"{slug}-large.jpg"), quality=86)
        print(slug, picture.size)
    return 0


if __name__ == "__main__":
    sys.exit(main())

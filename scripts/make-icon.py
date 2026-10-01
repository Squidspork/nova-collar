#!/usr/bin/env python3
from pathlib import Path
from subprocess import check_call
import tempfile

size = 1024
ppm = Path(tempfile.gettempdir()) / "novapup-icon.ppm"
png = Path(__file__).resolve().parent.parent / "build" / "icon.png"
iconset = Path(__file__).resolve().parent.parent / "build" / "icon.iconset"
icns = Path(__file__).resolve().parent.parent / "build" / "icon.icns"
png.parent.mkdir(parents=True, exist_ok=True)

cx = cy = size / 2
rows = []
for y in range(size):
    row = []
    for x in range(size):
        dx = x - cx
        dy = y - cy
        r = (dx * dx + dy * dy) ** 0.5
        if r > 470:
            row += [0, 0, 0]
        elif r > 430:
            row += [10, 22, 18]
        else:
            g = 16 + int(185 * (1 - r / 470))
            row += [8, min(g, 200), 80]
        if ((x - 390) ** 2 + (y - 430) ** 2) ** 0.5 < 70:
            row[-3:] = [236, 253, 245]
        if ((x - 634) ** 2 + (y - 430) ** 2) ** 0.5 < 70:
            row[-3:] = [236, 253, 245]
        if ((x - 390) ** 2 + (y - 430) ** 2) ** 0.5 < 28:
            row[-3:] = [11, 15, 13]
        if ((x - 634) ** 2 + (y - 430) ** 2) ** 0.5 < 28:
            row[-3:] = [11, 15, 13]
    rows.append(bytes(row))

ppm.write_bytes(f"P6\n{size} {size}\n255\n".encode() + b"".join(rows))
check_call(["sips", "-s", "format", "png", str(ppm), "--out", str(png)])
if iconset.exists():
    for old in iconset.iterdir():
        old.unlink()
else:
    iconset.mkdir()
for dim in (16, 32, 64, 128, 256, 512, 1024):
    check_call(["sips", "-z", str(dim), str(dim), str(png), "--out", str(iconset / f"icon_{dim}x{dim}.png")])
    if dim <= 512:
        check_call(["sips", "-z", str(dim * 2), str(dim * 2), str(png), "--out", str(iconset / f"icon_{dim}x{dim}@2x.png")])
check_call(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)])
print(icns)

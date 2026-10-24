#!/usr/bin/env python3
"""Render a captured ANSI terminal transcript to a PNG (used for docs/screenshots).

usage: term2png.py input.ansi output.png ["$ command shown as the prompt"]
"""
import re
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SIZE = 15
BG = (22, 24, 30)
FG = (215, 218, 224)
COLORS = {31: (240, 98, 98), 32: (110, 210, 120), 33: (235, 190, 80), 35: (200, 130, 230), 36: (90, 200, 220)}
DIM = (120, 126, 138)

src, out = sys.argv[1], sys.argv[2]
prompt = sys.argv[3] if len(sys.argv) > 3 else None
text = open(src, encoding="utf-8").read().rstrip("\n")
lines = ([f"\x1b[36m❯\x1b[0m \x1b[1m{prompt}\x1b[0m", ""] if prompt else []) + text.split("\n")

font = ImageFont.truetype(FONT, SIZE)
bold = ImageFont.truetype(BOLD, SIZE)
cw = font.getlength("M")
lh = int(SIZE * 1.45)
plain = [re.sub(r"\x1b\[[0-9;]*m", "", l) for l in lines]
width = int(max(len(p) for p in plain) * cw) + 48
height = len(lines) * lh + 64
img = Image.new("RGB", (max(width, 640), height), BG)
d = ImageDraw.Draw(img)
for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
    d.ellipse((16 + i * 22, 14, 28 + i * 22, 26), fill=c)

y = 44
for line in lines:
    x = 24
    color, is_bold, dim = FG, False, False
    for part in re.split(r"(\x1b\[[0-9;]*m)", line):
        m = re.fullmatch(r"\x1b\[([0-9;]*)m", part)
        if m:
            for code in [int(c) for c in (m.group(1) or "0").split(";") if c]:
                if code == 0:
                    color, is_bold, dim = FG, False, False
                elif code == 1:
                    is_bold = True
                elif code == 2:
                    dim = True
                elif code in COLORS:
                    color = COLORS[code]
            continue
        if not part:
            continue
        f = bold if is_bold else font
        d.text((x, y), part, font=f, fill=DIM if dim and color == FG else color)
        x += f.getlength(part)
    y += lh
img.save(out)
print(out, img.size)

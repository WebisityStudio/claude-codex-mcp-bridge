#!/usr/bin/env python3
"""Generate the README demo GIF from the verified CLI demo sequence."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "bridge-demo.gif"
W, H = 1200, 675
BG = "#090d16"
PANEL = "#111827"
BORDER = "#263449"
WHITE = "#f4f7fb"
MUTED = "#94a3b8"
CYAN = "#2ee6ff"
ORANGE = "#ffb347"
GREEN = "#58d68d"


def font(size: int, bold: bool = False):
    candidates = [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()

TITLE = font(34, True)
SUB = font(20)
MONO = font(21)
SMALL = font(17)


def rr(draw, box, radius=20, fill=PANEL, outline=BORDER, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def frame(step: int) -> Image.Image:
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.text((52, 32), "Claude Codex MCP Bridge", font=TITLE, fill=WHITE)
    d.text((52, 78), "Real local send → wait → wake → acknowledge demo", font=SUB, fill=MUTED)

    rr(d, (52, 125, 550, 540))
    rr(d, (650, 125, 1148, 540))
    d.ellipse((82, 153, 106, 177), fill=CYAN)
    d.text((122, 148), "CLAUDE", font=MONO, fill=CYAN)
    d.ellipse((680, 153, 704, 177), fill=ORANGE)
    d.text((720, 148), "CODEX", font=MONO, fill=ORANGE)

    d.text((82, 205), "$ npx claude-codex-mcp-bridge demo", font=SMALL, fill=WHITE)
    d.text((82, 250), "thread: demo-live", font=SMALL, fill=MUTED)
    d.text((680, 205), "bridge_wait(thread: demo-live)", font=SMALL, fill=WHITE)

    if step >= 1:
        d.text((680, 250), "● waiting", font=SMALL, fill=ORANGE)
    if step >= 2:
        rr(d, (92, 310, 510, 395), radius=14, fill="#12243a", outline="#23506b")
        d.text((115, 326), "Review the proposed change", font=SMALL, fill=WHITE)
        d.text((115, 355), "and report the main risk.", font=SMALL, fill=WHITE)
        d.line((525, 352, 640, 352), fill=CYAN, width=5)
        d.polygon([(640, 352), (621, 341), (621, 363)], fill=CYAN)
        d.text((522, 320), "bridge_send", font=SMALL, fill=CYAN, anchor="mm")
    if step >= 3:
        d.text((680, 250), "● woke automatically", font=SMALL, fill=GREEN)
        rr(d, (690, 310, 1108, 395), radius=14, fill="#2b2114", outline="#6b4c23")
        d.text((713, 326), "Message received without", font=SMALL, fill=WHITE)
        d.text((713, 355), "manual inbox polling", font=SMALL, fill=WHITE)
    if step >= 4:
        d.text((680, 430), "✓ acknowledged", font=SMALL, fill=GREEN)
        d.text((680, 462), "✓ thread history preserved", font=SMALL, fill=GREEN)
    if step >= 5:
        rr(d, (345, 565, 855, 635), radius=18, fill="#10291e", outline="#2e8b57")
        d.text((600, 600), "✓ Bridge demo passed", font=MONO, fill=GREEN, anchor="mm")
    else:
        d.text((600, 600), "Local SQLite WAL • no cloud relay • no network port", font=SMALL, fill=MUTED, anchor="mm")
    return im


frames = [frame(i) for i in range(6)]
durations = [900, 1100, 1400, 1300, 1200, 2200]
OUT.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
print(OUT)

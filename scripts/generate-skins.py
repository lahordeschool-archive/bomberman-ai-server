"""Generate the ten custom 17x26 Bomberman sprite sheets from the SNES reference."""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "apps/web/public/game/sprites/snes_white.png"
OUTPUT = ROOT / "apps/web/public/game/skins"

SKINS = {
    "ember": ((255, 112, 24), (255, 215, 64), "horns"),
    "moss": ((68, 168, 72), (194, 224, 92), "leaf"),
    "tide": ((24, 174, 214), (96, 234, 255), "fin"),
    "sunset": ((244, 98, 128), (255, 190, 84), "band"),
    "royal": ((132, 72, 214), (250, 204, 72), "jewel"),
    "neon": ((30, 235, 176), (255, 54, 224), "visor"),
    "frost": ((142, 218, 255), (245, 252, 255), "crystal"),
    "shadow": ((66, 58, 88), (206, 68, 255), "hood"),
    "galaxy": ((54, 52, 148), (255, 120, 224), "stars"),
    "crown": ((230, 164, 26), (255, 242, 110), "crown"),
}

PLAYER_TINTS = {
    "white": ((245, 245, 245), 0.08),
    "red": ((255, 42, 32), 0.24),
    "blue": ((38, 92, 255), 0.24),
    "black": ((30, 30, 38), 0.32),
}


def tint(color, player_tint, shade=1.0):
    target, strength = player_tint
    return tuple(
        min(255, round((channel * (1 - strength) + target_channel * strength) * shade))
        for channel, target_channel in zip(color, target)
    )


def decorate(draw, frame, kind, accent):
    x = frame * 17
    dark = tuple(max(0, channel // 3) for channel in accent)
    if kind == "horns":
        draw.polygon([(x + 3, 5), (x + 5, 0), (x + 7, 6)], fill=dark)
        draw.polygon([(x + 10, 6), (x + 12, 0), (x + 14, 5)], fill=accent)
    elif kind == "leaf":
        draw.line([(x + 8, 5), (x + 9, 1)], fill=dark, width=1)
        draw.polygon([(x + 9, 2), (x + 13, 0), (x + 12, 4)], fill=accent)
    elif kind == "fin":
        draw.polygon([(x + 7, 5), (x + 10, 0), (x + 12, 6)], fill=accent)
    elif kind == "band":
        draw.line([(x + 3, 7), (x + 14, 7)], fill=accent, width=2)
    elif kind == "jewel":
        draw.polygon([(x + 8, 2), (x + 11, 5), (x + 8, 8), (x + 5, 5)], fill=dark)
        draw.point((x + 8, 4), fill=accent)
    elif kind == "visor":
        draw.rounded_rectangle((x + 3, 7, x + 14, 10), radius=1, fill=dark)
        draw.line([(x + 5, 8), (x + 12, 8)], fill=accent, width=1)
    elif kind == "crystal":
        draw.polygon([(x + 8, 0), (x + 11, 5), (x + 8, 7), (x + 5, 5)], fill=accent)
    elif kind == "hood":
        draw.polygon([(x + 2, 7), (x + 5, 1), (x + 8, 5), (x + 11, 1), (x + 15, 7)], fill=dark)
    elif kind == "stars":
        draw.point((x + 5, 5), fill=accent)
        draw.point((x + 11, 3), fill=accent)
        draw.point((x + 13, 8), fill=(255, 255, 255))
    elif kind == "crown":
        draw.polygon(
            [(x + 4, 6), (x + 4, 1), (x + 7, 4), (x + 9, 0), (x + 11, 4), (x + 14, 1), (x + 13, 7)],
            fill=accent,
        )
        draw.line([(x + 4, 7), (x + 13, 7)], fill=dark, width=1)


def generate():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    source = Image.open(SOURCE).convert("RGBA")
    for slug, (base, accent, decoration) in SKINS.items():
        for player_color, player_tint in PLAYER_TINTS.items():
            image = source.copy()
            pixels = image.load()
            for y in range(image.height):
                for x in range(image.width):
                    red, green, blue, alpha = pixels[x, y]
                    if alpha == 0:
                        continue
                    # The reference's neutral suit is grayscale; preserve face, eyes, and outline.
                    if red == green == blue and red >= 48:
                        shade = 0.42 + 0.58 * (red / 255)
                        pixels[x, y] = (*tint(base, player_tint, shade), alpha)
                    elif red > 130 and blue > 90 and green < 80:
                        pixels[x, y] = (*tint(accent, player_tint), alpha)
            draw = ImageDraw.Draw(image)
            # Walking frames only. Death/victory poses keep their original silhouette.
            for frame in range(12):
                decorate(draw, frame, decoration, tint(accent, player_tint))
            image.save(OUTPUT / f"{slug}_{player_color}.png", optimize=True)


if __name__ == "__main__":
    generate()

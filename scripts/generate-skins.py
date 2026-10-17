"""Generate custom player, bomb, and explosion sheets from the SNES references."""

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
    "duck": ((247, 207, 44), (255, 126, 32), "duck"),
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
    elif kind == "duck":
        pose = frame // 3
        if pose == 0:  # Back view: a jaunty feather.
            draw.polygon([(x + 7, 4), (x + 8, 0), (x + 10, 4)], fill=accent)
        elif pose == 1:  # Facing left.
            draw.polygon([(x + 5, 8), (x + 1, 10), (x + 5, 12)], fill=accent)
        elif pose == 2:  # Facing the camera.
            draw.rectangle((x + 6, 9, x + 11, 11), fill=accent)
            draw.point((x + 5, 7), fill=(255, 255, 255))
            draw.point((x + 12, 7), fill=(255, 255, 255))
        else:  # Facing right.
            draw.polygon([(x + 12, 8), (x + 16, 10), (x + 12, 12)], fill=accent)


def shade_color(color, factor):
    return tuple(min(255, max(0, round(channel * factor))) for channel in color)


def draw_bomb(draw, frame, kind, base, accent):
    """Draw a full 16×16 themed bomb (not an icon stuck on the SNES ball)."""
    x = frame * 16
    bob = (0, -1, 0, 1)[frame % 4]
    spark = (0, 1, 0, 1)[frame % 4]
    white = (245, 250, 255)
    black = (18, 16, 20)
    wood = shade_color(base, 0.55)
    wood_hi = shade_color(base, 0.85)
    wood_lo = shade_color(base, 0.35)

    if kind == "horns":  # Ember: a squat TNT crate with a sparking fuse.
        # Crate body
        draw.rectangle((x + 2, 5 + bob, x + 13, 14 + bob), fill=wood_lo)
        draw.rectangle((x + 3, 6 + bob, x + 12, 13 + bob), fill=wood)
        draw.rectangle((x + 3, 6 + bob, x + 12, 7 + bob), fill=wood_hi)
        # Red warning band
        band = shade_color(base, 1.05)
        draw.rectangle((x + 3, 9 + bob, x + 12, 11 + bob), fill=band)
        draw.rectangle((x + 3, 9 + bob, x + 12, 9 + bob), fill=accent)
        # "TNT" ticks (readable as lettering at 16px)
        draw.point((x + 5, 10 + bob), fill=white)
        draw.point((x + 8, 10 + bob), fill=white)
        draw.point((x + 11, 10 + bob), fill=white)
        # Wood grain / straps
        draw.line([(x + 2, 5 + bob), (x + 2, 14 + bob)], fill=black)
        draw.line([(x + 13, 5 + bob), (x + 13, 14 + bob)], fill=black)
        draw.line([(x + 2, 14 + bob), (x + 13, 14 + bob)], fill=black)
        # Fuse + spark
        draw.line([(x + 8, 5 + bob), (x + 8, 3 + bob)], fill=(60, 48, 36))
        draw.point((x + 8 + spark, 2 + bob), fill=accent)
        draw.point((x + 7 + spark, 1 + bob), fill=white)

    elif kind == "fin":  # Tide: a filled water canteen / gourd.
        body = base
        body_hi = accent
        body_lo = shade_color(base, 0.55)
        cork = (168, 118, 64)
        cork_hi = (214, 168, 98)
        # Flask body (rounded bottle)
        draw.ellipse((x + 3, 5 + bob, x + 12, 14 + bob), fill=body_lo)
        draw.ellipse((x + 4, 6 + bob, x + 11, 13 + bob), fill=body)
        # Water highlight / fill line that bobs
        draw.ellipse((x + 5, 7 + bob, x + 9, 10 + bob), fill=body_hi)
        draw.point((x + 6, 8 + bob), fill=white)
        # Neck + cork
        draw.rectangle((x + 6, 3 + bob, x + 9, 6 + bob), fill=body_lo)
        draw.rectangle((x + 6, 2 + bob, x + 9, 4 + bob), fill=cork)
        draw.point((x + 7, 2 + bob), fill=cork_hi)
        # Strap loop
        draw.arc((x + 9, 4 + bob, x + 13, 8 + bob), 200, 40, fill=shade_color(base, 0.4), width=1)
        # Bubble that drifts with the tick
        draw.point((x + 9, 10 + bob - spark), fill=white)

    elif kind == "leaf":  # Moss: a seed pod / pinecone bomb.
        draw.ellipse((x + 3, 4 + bob, x + 12, 14 + bob), fill=shade_color(base, 0.45))
        draw.ellipse((x + 4, 5 + bob, x + 11, 13 + bob), fill=base)
        for row, y in enumerate((7, 9, 11)):
            inset = row % 2
            draw.line([(x + 5 + inset, y + bob), (x + 10 - inset, y + bob)], fill=accent)
        draw.polygon([(x + 7, 3 + bob), (x + 9, 3 + bob), (x + 8, 1 + bob)], fill=accent)

    elif kind == "band":  # Sunset: a glowing sun orb.
        draw.ellipse((x + 2, 3 + bob, x + 13, 14 + bob), fill=shade_color(base, 0.5))
        draw.ellipse((x + 3, 4 + bob, x + 12, 13 + bob), fill=base)
        draw.ellipse((x + 5, 6 + bob, x + 10, 11 + bob), fill=accent)
        draw.point((x + 6, 7 + bob), fill=white)
        # Rays that tick
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
            draw.point((x + 8 + dx * (3 + spark), 8 + bob + dy * (3 + spark)), fill=accent)

    elif kind == "jewel":  # Royal: a cut gem.
        draw.polygon(
            [(x + 8, 2 + bob), (x + 13, 7 + bob), (x + 8, 14 + bob), (x + 2, 7 + bob)],
            fill=shade_color(base, 0.55),
        )
        draw.polygon(
            [(x + 8, 4 + bob), (x + 11, 7 + bob), (x + 8, 12 + bob), (x + 4, 7 + bob)],
            fill=base,
        )
        draw.polygon(
            [(x + 8, 5 + bob), (x + 10, 7 + bob), (x + 8, 9 + bob), (x + 6, 7 + bob)],
            fill=accent,
        )
        draw.point((x + 7, 6 + bob), fill=white)

    elif kind == "visor":  # Neon: a battery / energy cell.
        draw.rectangle((x + 4, 3 + bob, x + 11, 13 + bob), fill=black)
        draw.rectangle((x + 5, 4 + bob, x + 10, 12 + bob), fill=shade_color(base, 0.45))
        level = 5 + (frame % 4)
        draw.rectangle((x + 5, 12 - level + bob, x + 10, 12 + bob), fill=base)
        draw.rectangle((x + 6, 12 - level + bob, x + 9, 12 - level + 1 + bob), fill=accent)
        draw.rectangle((x + 6, 2 + bob, x + 9, 3 + bob), fill=accent)
        draw.point((x + 6, 5 + bob), fill=white)

    elif kind == "crystal":  # Frost: an ice chunk.
        draw.polygon(
            [(x + 8, 2 + bob), (x + 13, 8 + bob), (x + 10, 14 + bob), (x + 5, 14 + bob), (x + 2, 8 + bob)],
            fill=shade_color(base, 0.55),
        )
        draw.polygon(
            [(x + 8, 4 + bob), (x + 11, 8 + bob), (x + 9, 12 + bob), (x + 6, 12 + bob), (x + 4, 8 + bob)],
            fill=base,
        )
        draw.line([(x + 7, 5 + bob), (x + 7, 11 + bob)], fill=white)
        draw.point((x + 9, 7 + bob), fill=accent)

    elif kind == "hood":  # Shadow: a dark urn / vial.
        draw.ellipse((x + 3, 5 + bob, x + 12, 14 + bob), fill=shade_color(base, 0.4))
        draw.ellipse((x + 4, 6 + bob, x + 11, 13 + bob), fill=base)
        draw.rectangle((x + 6, 3 + bob, x + 9, 6 + bob), fill=shade_color(base, 0.3))
        draw.ellipse((x + 5, 2 + bob, x + 10, 5 + bob), fill=black)
        draw.point((x + 7, 8 + bob), fill=accent)
        draw.point((x + 8, 9 + bob + spark), fill=accent)

    elif kind == "stars":  # Galaxy: a tiny planet.
        draw.ellipse((x + 2, 3 + bob, x + 13, 14 + bob), fill=shade_color(base, 0.5))
        draw.ellipse((x + 3, 4 + bob, x + 12, 13 + bob), fill=base)
        draw.arc((x + 1, 6 + bob, x + 14, 11 + bob), 200, 340, fill=accent, width=1)
        draw.point((x + 6, 7 + bob), fill=white)
        draw.point((x + 10, 10 + bob), fill=accent)
        draw.point((x + 5 + spark, 5 + bob), fill=white)

    elif kind == "crown":  # Crown: a gold coin pouch / treasure bag.
        draw.ellipse((x + 3, 6 + bob, x + 12, 14 + bob), fill=shade_color(base, 0.55))
        draw.ellipse((x + 4, 7 + bob, x + 11, 13 + bob), fill=base)
        draw.polygon([(x + 5, 7 + bob), (x + 8, 3 + bob), (x + 11, 7 + bob)], fill=shade_color(base, 0.4))
        draw.point((x + 8, 4 + bob), fill=accent)
        draw.point((x + 6, 9 + bob), fill=accent)
        draw.point((x + 9, 10 + bob), fill=white)

    elif kind == "duck":  # Duck: a round duck bomb with a lit fuse.
        draw.ellipse((x + 2, 5 + bob, x + 12, 14 + bob), fill=black)
        draw.ellipse((x + 3, 6 + bob, x + 11, 13 + bob), fill=base)
        draw.point((x + 8, 8 + bob), fill=black)
        draw.polygon(
            [(x + 10, 9 + bob), (x + 14, 10 + bob), (x + 10, 11 + bob)],
            fill=accent,
        )
        draw.line([(x + 7, 5 + bob), (x + 8, 2 + bob)], fill=black)
        draw.point((x + 8 + spark, 1 + bob), fill=white)


def generate_bomb(slug, base, accent, decoration, player_color, player_tint):
    # Four ticking frames — matches the SNES bomb sheet layout the renderer reads.
    image = Image.new("RGBA", (64, 16))
    draw = ImageDraw.Draw(image)
    themed_base = tint(base, player_tint)
    themed_accent = tint(accent, player_tint)
    for frame in range(4):
        draw_bomb(draw, frame, decoration, themed_base, themed_accent)
    image.save(OUTPUT / f"{slug}_{player_color}_bomb.png", optimize=True)


def effect_orientation(row):
    """Maps flame sheet rows to classic Bomberman blast parts."""
    return {
        1: "center",
        2: "vertical",
        3: "horizontal",
        4: "endUp",
        5: "endDown",
        6: "endRight",
        7: "endLeft",
    }.get(row, "center")


def draw_ember_blast(draw, left, top, base, accent, white, phase, orientation):
    """Classic Bomberman cross blast, but hotter and more explosive for Ember."""
    pulse = (0, 1, 2, 1, 0)[phase]
    fleck = phase % 2

    if orientation == "center":
        # Blooming fireball with a white-hot core and flying sparks.
        size = 5 + pulse
        draw.ellipse(
            (left + 7 - size, top + 7 - size, left + 8 + size, top + 8 + size),
            fill=base,
        )
        draw.ellipse(
            (left + 8 - size + 1, top + 8 - size + 1, left + 7 + size - 1, top + 7 + size - 1),
            fill=accent,
        )
        core = 2 + (1 if pulse > 0 else 0)
        draw.ellipse(
            (left + 7 - core, top + 7 - core, left + 8 + core, top + 8 + core),
            fill=white,
        )
        sparks = (
            (2, 3), (13, 2), (14, 12), (1, 13),
            (4, 1), (11, 14), (1, 7), (14, 8),
        )
        for index, (sx, sy) in enumerate(sparks):
            if (index + phase) % 2 == 0:
                draw.point((left + sx, top + sy), fill=accent if index % 3 else white)

    elif orientation == "vertical":
        draw.rectangle((left + 4 - pulse // 2, top, left + 11 + pulse // 2, top + 15), fill=base)
        draw.rectangle((left + 6, top, left + 9, top + 15), fill=accent)
        draw.rectangle((left + 7, top + 1, left + 8, top + 14), fill=white)
        for y in (2, 6, 10, 13):
            draw.point((left + 3 - fleck, top + y), fill=accent)
            draw.point((left + 12 + fleck, top + y + 1), fill=white)

    elif orientation == "horizontal":
        draw.rectangle((left, top + 4 - pulse // 2, left + 15, top + 11 + pulse // 2), fill=base)
        draw.rectangle((left, top + 6, left + 15, top + 9), fill=accent)
        draw.rectangle((left + 1, top + 7, left + 14, top + 8), fill=white)
        for x in (2, 6, 10, 13):
            draw.point((left + x, top + 3 - fleck), fill=accent)
            draw.point((left + x + 1, top + 12 + fleck), fill=white)

    elif orientation == "endUp":
        draw.polygon(
            [(left + 3, top + 15), (left + 7 - pulse, top + 4), (left + 8, top + 1),
             (left + 9 + pulse, top + 4), (left + 12, top + 15)],
            fill=base,
        )
        draw.polygon(
            [(left + 5, top + 15), (left + 7, top + 6), (left + 8, top + 3),
             (left + 9, top + 6), (left + 10, top + 15)],
            fill=accent,
        )
        draw.rectangle((left + 7, top + 6, left + 8, top + 15), fill=white)
        draw.point((left + 4 + fleck, top + 8), fill=accent)
        draw.point((left + 11 - fleck, top + 5), fill=white)

    elif orientation == "endDown":
        draw.polygon(
            [(left + 3, top), (left + 7 - pulse, top + 11), (left + 8, top + 14),
             (left + 9 + pulse, top + 11), (left + 12, top)],
            fill=base,
        )
        draw.polygon(
            [(left + 5, top), (left + 7, top + 9), (left + 8, top + 12),
             (left + 9, top + 9), (left + 10, top)],
            fill=accent,
        )
        draw.rectangle((left + 7, top, left + 8, top + 9), fill=white)
        draw.point((left + 4 + fleck, top + 7), fill=accent)
        draw.point((left + 11 - fleck, top + 10), fill=white)

    elif orientation == "endRight":
        draw.polygon(
            [(left, top + 3), (left + 11, top + 7 - pulse), (left + 14, top + 8),
             (left + 11, top + 9 + pulse), (left, top + 12)],
            fill=base,
        )
        draw.polygon(
            [(left, top + 5), (left + 9, top + 7), (left + 12, top + 8),
             (left + 9, top + 9), (left, top + 10)],
            fill=accent,
        )
        draw.rectangle((left, top + 7, left + 9, top + 8), fill=white)
        draw.point((left + 7, top + 4 + fleck), fill=accent)
        draw.point((left + 10, top + 11 - fleck), fill=white)

    else:  # endLeft
        draw.polygon(
            [(left + 15, top + 3), (left + 4, top + 7 - pulse), (left + 1, top + 8),
             (left + 4, top + 9 + pulse), (left + 15, top + 12)],
            fill=base,
        )
        draw.polygon(
            [(left + 15, top + 5), (left + 6, top + 7), (left + 3, top + 8),
             (left + 6, top + 9), (left + 15, top + 10)],
            fill=accent,
        )
        draw.rectangle((left + 6, top + 7, left + 15, top + 8), fill=white)
        draw.point((left + 8, top + 4 + fleck), fill=accent)
        draw.point((left + 5, top + 11 - fleck), fill=white)


def draw_effect(draw, box, kind, base, accent, phase, orientation):
    left, top = box
    pulse = (0, 1, 2, 1, 0)[phase]
    white = (245, 250, 255, 255)
    base = (*base, 255)
    accent = (*accent, 255)
    axis = (
        "vertical"
        if orientation in ("vertical", "endUp", "endDown")
        else "horizontal"
        if orientation in ("horizontal", "endRight", "endLeft")
        else "center"
    )
    if kind == "horns":  # Ember: classic cross blast, hotter and sparkier.
        draw_ember_blast(draw, left, top, base, accent, white, phase, orientation)
    elif kind == "leaf":  # Moss: a rapidly growing thorny vine.
        if axis == "vertical":
            draw.line([(left + 8, top), (left + 8, top + 15)], fill=base, width=3)
        elif axis == "horizontal":
            draw.line([(left, top + 8), (left + 15, top + 8)], fill=base, width=3)
        else:
            draw.line([(left + 2, top + 13), (left + 13, top + 2)], fill=base, width=3)
        draw.polygon([(left + 4, top + 8), (left + 1, top + 4), (left + 7, top + 5)], fill=accent)
        draw.polygon([(left + 10, top + 9), (left + 15, top + 11), (left + 11, top + 5)], fill=accent)
    elif kind == "fin":  # Tide: cresting water and bubbles.
        draw.rectangle((left, top + 8 - pulse, left + 15, top + 15), fill=base)
        draw.arc((left - 2, top + 2 - pulse, left + 9, top + 13), 200, 355, fill=accent, width=3)
        draw.arc((left + 6, top + 1, left + 17, top + 12 + pulse), 200, 355, fill=white, width=2)
        draw.ellipse((left + 3 + phase, top + 2, left + 5 + phase, top + 4), fill=white)
    elif kind == "band":  # Sunset: a band of solar light.
        draw.ellipse((left + 3 - pulse, top + 3 - pulse, left + 12 + pulse, top + 12 + pulse), fill=accent)
        if axis == "vertical":
            draw.rectangle((left + 6, top, left + 9, top + 15), fill=base)
        else:
            draw.rectangle((left, top + 6, left + 15, top + 9), fill=base)
    elif kind == "jewel":  # Royal: gem shards.
        draw.polygon([(left + 8, top + 1), (left + 14, top + 8), (left + 8, top + 15), (left + 2, top + 8)], fill=base)
        draw.polygon([(left + 8, top + 3 + pulse), (left + 11, top + 8), (left + 8, top + 12), (left + 5, top + 8)], fill=accent)
        draw.point((left + 4, top + 3), fill=white)
    elif kind == "visor":  # Neon: a hard laser with a bright core.
        if axis == "vertical":
            draw.rectangle((left + 4 - pulse, top, left + 11 + pulse, top + 15), fill=base)
            draw.rectangle((left + 7, top, left + 8, top + 15), fill=white)
        elif axis == "horizontal":
            draw.rectangle((left, top + 4 - pulse, left + 15, top + 11 + pulse), fill=base)
            draw.rectangle((left, top + 7, left + 15, top + 8), fill=white)
        else:
            draw.rectangle((left + 5 - pulse, top, left + 10 + pulse, top + 15), fill=base)
            draw.rectangle((left, top + 5 - pulse, left + 15, top + 10 + pulse), fill=accent)
            draw.rectangle((left + 7, top, left + 8, top + 15), fill=white)
            draw.rectangle((left, top + 7, left + 15, top + 8), fill=white)
    elif kind == "crystal":  # Frost: a moving wall of ice.
        draw.rectangle((left, top + 4 - pulse, left + 15, top + 15), fill=base)
        for offset in (1, 6, 11):
            draw.polygon(
                [(left + offset, top + 7), (left + offset + 3, top + 1 + pulse),
                 (left + offset + 5, top + 7)],
                fill=accent,
            )
        draw.line([(left + 2, top + 10), (left + 14, top + 10)], fill=white, width=1)
    elif kind == "hood":  # Shadow: rolling black smoke.
        smoke = (18, 18, 24, 255)
        smoke_edge = (82, 76, 92, 255)
        for cx, cy, radius in ((4, 9, 4), (8, 6 + pulse, 5), (12, 10, 4)):
            draw.ellipse(
                (left + cx - radius, top + cy - radius, left + cx + radius, top + cy + radius),
                fill=smoke,
                outline=smoke_edge,
            )
        draw.ellipse((left + 6, top + 6, left + 7, top + 7), fill=accent)
        draw.ellipse((left + 10, top + 7, left + 11, top + 8), fill=accent)
    elif kind == "stars":  # Galaxy: a small star field.
        draw.ellipse((left + 2, top + 2, left + 14, top + 14), fill=base)
        stars = ((4 + phase, 5), (11, 3 + phase), (8, 12 - phase), (13 - phase, 9))
        for index, (x, y) in enumerate(stars):
            color = white if index % 2 else accent
            draw.point((left + x, top + y), fill=color)
            if index == phase % len(stars):
                draw.line([(left + x - 1, top + y), (left + x + 1, top + y)], fill=color)
                draw.line([(left + x, top + y - 1), (left + x, top + y + 1)], fill=color)
    elif kind == "crown":  # Crown: spinning silver coins.
        silver = (150, 168, 188, 255)
        dark = (72, 88, 104, 255)
        for offset in (1, 7):
            # Coins turn as they travel, but stay wide enough to read as coins at 16 px.
            width = 6
            cx = left + offset + 3
            draw.ellipse(
                (cx - width // 2, top + offset, cx + width // 2, top + offset + 6),
                fill=silver,
                outline=white,
            )
            shine_x = cx - 1 + (phase % 3)
            draw.line([(shine_x, top + offset + 1), (shine_x, top + offset + 4)], fill=white)
            draw.point((cx, top + offset + 3), fill=dark)
    elif kind == "duck":  # Duck: a burst of spinning feathers.
        feather = (255, 248, 198, 255)
        positions = (
            (3 + phase, 4),
            (11 - phase, 8),
            (5 + (phase % 2) * 4, 12),
        )
        for index, (x, y) in enumerate(positions):
            draw.polygon(
                [
                    (left + x, top + y - 3),
                    (left + x + 3, top + y),
                    (left + x, top + y + 3),
                    (left + x - 1, top + y),
                ],
                fill=feather if index % 2 == 0 else base,
                outline=accent,
            )
            draw.line(
                [(left + x, top + y - 2), (left + x, top + y + 2)],
                fill=accent,
            )


def generate_flame(slug, base, accent, decoration, player_color, player_tint):
    image = Image.new("RGBA", (80, 128))
    draw = ImageDraw.Draw(image)
    themed_base = tint(base, player_tint)
    themed_accent = tint(accent, player_tint)
    for frame in range(40):
        row, phase = divmod(frame, 5)
        if row == 0:  # Unused legacy frames.
            continue
        draw_effect(
            draw,
            (phase * 16, row * 16),
            decoration,
            themed_base,
            themed_accent,
            phase,
            effect_orientation(row),
        )
    image.save(OUTPUT / f"{slug}_{player_color}_flame.png", optimize=True)


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
            generate_bomb(slug, base, accent, decoration, player_color, player_tint)
            generate_flame(slug, base, accent, decoration, player_color, player_tint)


if __name__ == "__main__":
    generate()

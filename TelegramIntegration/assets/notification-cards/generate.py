from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


WIDTH = 1280
HEIGHT = 450
ROOT = Path(__file__).resolve().parent
FONT = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "seguisb.ttf"
BACKGROUND = ROOT / "background-hex.png"

CATEGORIES = {
    "action": {
        "title": "ТРЕБУЕТСЯ ДЕЙСТВИЕ",
        "accent": (255, 76, 96),
        "symbol": "alert",
    },
    "done": {
        "title": "ЗАДАЧА ВЫПОЛНЕНА",
        "accent": (55, 214, 122),
        "symbol": "check",
    },
    "intermediate": {
        "title": "ПРОМЕЖУТОЧНЫЙ РЕЗУЛЬТАТ",
        "accent": (169, 105, 255),
        "symbol": "milestone",
    },
    "progress": {
        "title": "ЗАДАЧА ВЫПОЛНЯЕТСЯ",
        "accent": (64, 183, 255),
        "symbol": "progress",
    },
    "warning": {
        "title": "ВНИМАНИЕ",
        "accent": (255, 184, 66),
        "symbol": "warning",
    },
    "info": {
        "title": "ИНФОРМАЦИЯ",
        "accent": (86, 141, 255),
        "symbol": "info",
    },
}


def mix(a: tuple[int, int, int], b: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(round(x + (y - x) * amount) for x, y in zip(a, b))


def draw_symbol(
    draw: ImageDraw.ImageDraw,
    symbol: str,
    accent: tuple[int, int, int],
) -> None:
    white = (232, 242, 250, 255)
    muted = (146, 165, 181, 210)
    line_width = 7
    node_radius = 8

    def node(x: int, y: int, *, fill: tuple[int, int, int, int] | None = None) -> None:
        color = fill or accent + (255,)
        draw.ellipse(
            (x - node_radius, y - node_radius, x + node_radius, y + node_radius),
            fill=color,
        )

    if symbol == "alert":
        draw.line((67, 225, 108, 225), fill=muted, width=line_width)
        draw.line((152, 225, 193, 225), fill=muted, width=line_width)
        draw.line((130, 170, 130, 225), fill=white, width=line_width)
        draw.ellipse((119, 159, 141, 181), outline=white, width=5)
        node(130, 170)
        draw.line((108, 225, 152, 225), fill=accent + (255,), width=line_width)
        node(130, 225)
    elif symbol == "check":
        draw.line((67, 225, 100, 258, 158, 187, 193, 187), fill=white, width=line_width, joint="curve")
        node(67, 225, fill=muted)
        node(193, 187)
    elif symbol == "milestone":
        draw.line((62, 225, 198, 225), fill=muted, width=line_width)
        draw.polygon((130, 188, 167, 225, 130, 262, 93, 225), outline=accent + (255,), width=line_width)
        node(62, 225, fill=white)
        node(198, 225, fill=white)
    elif symbol == "progress":
        chevrons = [
            ((65, 185, 105, 225, 65, 265), (128, 150, 168, 180)),
            ((105, 185, 145, 225, 105, 265), (185, 204, 220, 225)),
            ((145, 185, 185, 225, 145, 265), accent + (255,)),
        ]
        for points, color in chevrons:
            draw.line(points, fill=color, width=line_width, joint="curve")
    elif symbol == "warning":
        draw.line((64, 225, 126, 225, 194, 225), fill=muted, width=line_width, joint="curve")
        draw.line((126, 225, 174, 177), fill=accent + (255,), width=line_width)
        node(126, 225, fill=white)
        node(174, 177)
        draw.ellipse((186, 217, 202, 233), outline=muted, width=4)
    else:
        rows = [
            (78, 187, 190, 187, 110),
            (63, 225, 198, 225, 160),
            (82, 263, 183, 263, 128),
        ]
        for x1, y1, x2, y2, marker_x in rows:
            draw.line((x1, y1, x2, y2), fill=muted, width=6)
            node(marker_x, y1, fill=accent + (255,))


def generate(name: str, spec: dict[str, object]) -> Path:
    accent = spec["accent"]
    assert isinstance(accent, tuple)

    source = Image.open(BACKGROUND).convert("RGB")
    image = ImageOps.fit(
        source,
        (WIDTH, HEIGHT),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    ).convert("RGBA")

    glass = Image.new("RGBA", image.size, (4, 10, 18, 98))
    image = Image.alpha_composite(image, glass)

    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((-190, -150, 520, 600), fill=accent + (48,))
    glow_draw.ellipse((WIDTH - 440, -130, WIDTH + 160, 560), fill=accent + (18,))
    glow = glow.filter(ImageFilter.GaussianBlur(125))
    image = Image.alpha_composite(image, glow)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((2, 2, WIDTH - 3, HEIGHT - 3), radius=34, outline=(145, 174, 200, 68), width=3)
    draw.rounded_rectangle((0, 0, 14, HEIGHT), radius=7, fill=accent + (255,))
    draw.line((25, 24, WIDTH - 36, 24), fill=(229, 241, 252, 38), width=2)
    draw.line((25, HEIGHT - 25, WIDTH - 36, HEIGHT - 25), fill=(0, 0, 0, 130), width=3)

    panel_points = ((130, 128), (214, 176), (214, 274), (130, 322), (46, 274), (46, 176))
    panel_shadow_points = tuple((x + 7, y + 12) for x, y in panel_points)
    panel_shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(panel_shadow)
    shadow_draw.polygon(panel_shadow_points, fill=(0, 0, 0, 220))
    panel_shadow = panel_shadow.filter(ImageFilter.GaussianBlur(16))
    image = Image.alpha_composite(image, panel_shadow)

    draw = ImageDraw.Draw(image)
    draw.polygon(panel_points, fill=(5, 12, 20, 214))
    draw.line((46, 176, 130, 128, 214, 176), fill=(242, 249, 255, 76), width=3, joint="curve")
    draw.line((214, 176, 214, 274, 130, 322, 46, 274), fill=(0, 0, 0, 170), width=5, joint="curve")
    draw.polygon(panel_points, outline=accent + (176,), width=3)
    draw_symbol(draw, str(spec["symbol"]), accent)

    title = str(spec["title"])
    font_size = 66
    font = ImageFont.truetype(str(FONT), font_size)
    while draw.textlength(title, font=font) > WIDTH - 330:
        font_size -= 2
        font = ImageFont.truetype(str(FONT), font_size)
    text_box = draw.textbbox((0, 0), title, font=font)
    text_height = text_box[3] - text_box[1]
    text_y = (HEIGHT - text_height) / 2 - text_box[1]

    text_shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_text_draw = ImageDraw.Draw(text_shadow)
    shadow_text_draw.text((271, text_y + 9), title, font=font, fill=(0, 0, 0, 225), stroke_width=2)
    text_shadow = text_shadow.filter(ImageFilter.GaussianBlur(7))
    image = Image.alpha_composite(image, text_shadow)

    text_glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_text_draw = ImageDraw.Draw(text_glow)
    glow_text_draw.text((265, text_y), title, font=font, fill=accent + (68,))
    text_glow = text_glow.filter(ImageFilter.GaussianBlur(14))
    image = Image.alpha_composite(image, text_glow)

    draw = ImageDraw.Draw(image)
    draw.text(
        (265, text_y),
        title,
        font=font,
        fill=(240, 246, 252, 255),
        stroke_width=1,
        stroke_fill=(255, 255, 255, 80),
    )

    underline_width = min(850, math.ceil(draw.textlength(title, font=font)))
    underline_y = round(HEIGHT / 2 + 68)
    line_glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    line_glow_draw = ImageDraw.Draw(line_glow)
    line_glow_draw.rounded_rectangle(
        (265, underline_y - 2, 265 + underline_width, underline_y + 10),
        radius=6,
        fill=accent + (135,),
    )
    line_glow = line_glow.filter(ImageFilter.GaussianBlur(12))
    image = Image.alpha_composite(image, line_glow)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (265, underline_y, 265 + underline_width, underline_y + 7),
        radius=3,
        fill=accent + (225,),
    )
    draw.line(
        (265, underline_y, 265 + underline_width, underline_y),
        fill=(255, 255, 255, 120),
        width=1,
    )

    output = ROOT / f"{name}.png"
    image.convert("RGB").save(output, format="PNG", optimize=True)
    return output


if __name__ == "__main__":
    for category_name, category_spec in CATEGORIES.items():
        print(generate(category_name, category_spec))

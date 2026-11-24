import sys
from pathlib import Path

from PIL import Image, ImageOps


Image.MAX_IMAGE_PIXELS = 40_000_000


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: attachment_thumbnail.py SOURCE TARGET MAX_EDGE")
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    max_edge = max(64, min(1024, int(sys.argv[3])))
    with Image.open(source) as opened:
        opened.seek(0)
        image = ImageOps.exif_transpose(opened)
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        has_alpha = image.mode in {"RGBA", "LA"} or (
            image.mode == "P" and "transparency" in image.info
        )
        normalized = image.convert("RGBA" if has_alpha else "RGB")
        normalized.save(
            target,
            format="WEBP",
            quality=78,
            method=4,
            optimize=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

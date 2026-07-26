"""Render source-code ranges as phone-readable PNG images."""

from __future__ import annotations

import argparse
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont


BACKGROUND = "#0d1117"
PANEL = "#161b22"
TEXT = "#c9d1d9"
MUTED = "#6e7681"
KEYWORD = "#ff7b72"
STRING = "#a5d6ff"
COMMENT = "#8b949e"
NUMBER = "#79c0ff"
FUNCTION = "#d2a8ff"
ACCENT = "#58a6ff"

BSL_KEYWORDS = {
    "Функция", "КонецФункции", "Процедура", "КонецПроцедуры", "Экспорт",
    "Если", "Тогда", "ИначеЕсли", "Иначе", "КонецЕсли", "Для", "Каждого",
    "Из", "Цикл", "КонецЦикла", "Возврат", "Продолжить", "Прервать",
    "ВызватьИсключение", "Новый", "ТипЗнч", "Тип", "Неопределено", "Истина",
    "Ложь", "Попытка", "Исключение", "КонецПопытки",
}


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Source file")
    parser.add_argument("output_dir", type=Path, help="Directory for generated PNG files")
    parser.add_argument("--start", type=int, default=1, help="First line, starting at 1")
    parser.add_argument("--end", type=int, help="Last line, inclusive")
    parser.add_argument("--title", default="", help="Image title")
    parser.add_argument("--split-lines", type=int, default=45, help="Maximum lines per image")
    parser.add_argument("--width", type=int, default=1440, help="Image width")
    parser.add_argument("--font-size", type=int, default=22, help="Code font size")
    return parser.parse_args()


def tokenize(line: str):
    comment_at = line.find("//")
    code = line if comment_at < 0 else line[:comment_at]
    comment = "" if comment_at < 0 else line[comment_at:]
    pattern = re.compile(r'("(?:[^"]|"")*")|([А-Яа-яA-Za-z_][А-Яа-яA-Za-z_0-9]*)|(\d+(?:[.,]\d+)?)')
    position = 0

    for match in pattern.finditer(code):
        if match.start() > position:
            yield code[position:match.start()], TEXT
        value = match.group(0)
        if match.group(1):
            color = STRING
        elif match.group(3):
            color = NUMBER
        elif value in BSL_KEYWORDS:
            color = KEYWORD
        elif match.end() < len(code) and code[match.end():].lstrip().startswith("("):
            color = FUNCTION
        else:
            color = TEXT
        yield value, color
        position = match.end()

    if position < len(code):
        yield code[position:], TEXT
    if comment:
        yield comment, COMMENT


def font_path(bold: bool = False) -> Path:
    windows_font = Path(r"C:\Windows\Fonts") / ("consolab.ttf" if bold else "consola.ttf")
    if windows_font.exists():
        return windows_font
    raise RuntimeError("Consolas font was not found")


def render(
    source: Path,
    lines: list[str],
    first_line: int,
    title: str,
    output: Path,
    width: int,
    font_size: int,
) -> None:
    font = ImageFont.truetype(str(font_path()), font_size)
    title_font = ImageFont.truetype(str(font_path(True)), font_size + 3)
    small_font = ImageFont.truetype(str(font_path()), max(14, font_size - 6))
    line_height = font_size + 10
    header_height = 88
    padding = 28
    height = header_height + padding + line_height * len(lines) + padding
    image = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((16, 16, width - 16, height - 16), radius=18, fill=PANEL)
    draw.text((38, 29), title, font=title_font, fill="#f0f6fc")
    draw.text((38, 59), source.name, font=small_font, fill=ACCENT)

    number_width = 74
    y = header_height + 10
    for offset, line in enumerate(lines):
        line_number = first_line + offset
        draw.text((34, y), str(line_number).rjust(4), font=font, fill=MUTED)
        x = 34 + number_width
        for value, color in tokenize(line.expandtabs(4)):
            draw.text((x, y), value, font=font, fill=color)
            x += draw.textlength(value, font=font)
        y += line_height

    image.save(output, quality=95)


def main() -> None:
    options = arguments()
    if options.start < 1:
        raise ValueError("--start must be at least 1")
    if options.split_lines < 1:
        raise ValueError("--split-lines must be positive")

    source = options.source.resolve()
    all_lines = source.read_text(encoding="utf-8-sig").splitlines()
    last_line = options.end or len(all_lines)
    if last_line < options.start or last_line > len(all_lines):
        raise ValueError(f"Invalid range {options.start}:{last_line}; file has {len(all_lines)} lines")

    selected = all_lines[options.start - 1:last_line]
    options.output_dir.mkdir(parents=True, exist_ok=True)
    title = options.title.strip() or source.name

    generated = []
    for offset in range(0, len(selected), options.split_lines):
        chunk = selected[offset:offset + options.split_lines]
        first_line = options.start + offset
        chunk_last = first_line + len(chunk) - 1
        output = options.output_dir / f"{source.stem}-{first_line}-{chunk_last}.png"
        chunk_title = title if len(selected) <= options.split_lines else f"{title} · {first_line}–{chunk_last}"
        render(source, chunk, first_line, chunk_title, output, options.width, options.font_size)
        generated.append(output)

    for output in generated:
        print(output)


if __name__ == "__main__":
    main()

"""Рисует иконку xlamBOT и сохраняет её как .ico для сборки .exe.

Иконка строится кодом, без внешних картинок: скруглённый тёмный квадрат,
мятное кольцо, внутри — стилизованная «X» из двух скрещённых скоб и точка в
центре, как прицел. Каждый слой рисуется сразу в четырёх размерах, поэтому
кромки не мылятся при масштабировании в проводнике Windows.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 24, 32, 48, 64, 128, 256)

BG_TOP = (18, 24, 34)
BG_BOTTOM = (10, 13, 19)
MINT = (47, 224, 166)
MINT_SOFT = (111, 240, 198)
VIOLET = (141, 125, 255)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1),
                                           radius=radius, fill=255)
    return mask


def draw_icon(size: int) -> Image.Image:
    ss = size * 4  # рисуем крупно и уменьшаем: сглаживание бесплатно
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))

    grad = Image.new("RGBA", (ss, ss))
    gd = ImageDraw.Draw(grad)
    for y in range(ss):
        t = y / max(1, ss - 1)
        gd.line(
            [(0, y), (ss, y)],
            fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)) + (255,),
        )
    img.paste(grad, (0, 0), rounded_mask(ss, int(ss * 0.22)))

    d = ImageDraw.Draw(img)
    pad = ss * 0.5

    # Мятное кольцо
    ring_w = max(2, int(ss * 0.062))
    d.ellipse((pad * 0.42, pad * 0.42, ss - pad * 0.42, ss - pad * 0.42),
              outline=MINT + (255,), width=ring_w)

    # Дуга второго цвета: кольцо не выглядит плоским
    box = (pad * 0.42, pad * 0.42, ss - pad * 0.42, ss - pad * 0.42)
    d.arc(box, start=-58, end=118, fill=VIOLET + (255,), width=ring_w)

    # Скрещённые скобы, из которых собирается X
    arm = ss * 0.215
    cx = cy = ss / 2
    width = max(2, int(ss * 0.085))

    def stroke(p0, p1, color):
        d.line([p0, p1], fill=color, width=width)
        r = width / 2
        for p in (p0, p1):
            d.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=color)

    # Левая фигура: < и >, соединённые в X
    stroke((cx - arm, cy - arm * 0.95), (cx - arm * 0.05, cy), MINT_SOFT + (255,))
    stroke((cx - arm, cy + arm * 0.95), (cx - arm * 0.05, cy), MINT_SOFT + (255,))
    stroke((cx + arm, cy - arm * 0.95), (cx + arm * 0.05, cy), MINT + (255,))
    stroke((cx + arm, cy + arm * 0.95), (cx + arm * 0.05, cy), MINT + (255,))

    # Прицел в центре
    dot = ss * 0.052
    d.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=MINT_SOFT + (255,))
    inner = ss * 0.022
    d.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=BG_BOTTOM + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    images = {size: draw_icon(size) for size in SIZES}

    ico_path = Path("build_assets/xlambot.ico")
    ico_path.parent.mkdir(parents=True, exist_ok=True)
    images[256].save(ico_path, format="ICO",
                     sizes=[(s, s) for s in SIZES])
    print(f"иконка: {ico_path} ({ico_path.stat().st_size} байт)")

    png_path = Path("build_assets/xlambot.png")
    images[256].save(png_path)
    print(f"иконка PNG: {png_path} ({png_path.stat().st_size} байт)")

    for size in (16, 32, 48, 256):
        check = Path(f"build_assets/preview_{size}.png")
        images[size].save(check)
        print(f"  предпросмотр {size}x{size}: {check.stat().st_size} байт")

    # Проверка: все размеры читаются обратно
    reopened = Image.open(ico_path)
    got = sorted({s[0] for s in reopened.info.get("sizes", [(256, 256)])})
    print(f"  размеров в .ico: {got}")


if __name__ == "__main__":
    main()
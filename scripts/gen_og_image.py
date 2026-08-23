#!/usr/bin/env python3
"""生成站点 OG 图（apps/web/app/opengraph-image.png，1200x630）。

静态 PNG 是刻意的选择：opengraph-image.tsx 在 output:"export" 下会输出成无扩展名文件，
且 satori 在无中文字体的构建机上出豆腐块。域名或文案变更时改常量重跑本脚本：

    python3 scripts/gen_og_image.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "web" / "app" / "opengraph-image.png"

W, H = 1200, 630
BG = "#f7f7f5"
TEXT = "#171717"
MUTED = "#6b7280"
ACCENT = "#f0a23a"

KICKER = "IN-BROWSER IMAGE TOOLS"
TITLE = "图片工具箱"
SUBTITLE = "OCR 文字识别 · 图片压缩 · 背景去除，全程浏览器本地运行"
DOMAIN = "img.laifuyou.com"
NOTE = "图片不上传 · MIT 开源"

# macOS 15：PingFang 已不在 /System/Library/Fonts；用内置的 Hiragino Sans GB（W3/W6）
HIRAGINO_GB = "/System/Library/Fonts/Hiragino Sans GB.ttc"
HELVETICA = "/System/Library/Fonts/HelveticaNeue.ttc"


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, index=index)


def cjk_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    try:
        return font(HIRAGINO_GB, size, index=1 if bold else 0)
    except Exception:
        return font(HIRAGINO_GB, size)


def latin_font(size: int) -> ImageFont.FreeTypeFont:
    if Path(HELVETICA).exists():
        return font(HELVETICA, size)
    return cjk_font(size)


def draw_tracked(draw: ImageDraw.ImageDraw, xy, text: str, f, fill: str, tracking: int):
    """逐字绘制以支持字距（kicker 的宽排小号大写拉丁）。"""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + tracking


def main() -> None:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    title_font = cjk_font(118, bold=True)
    kicker_font = latin_font(30)
    domain_font = latin_font(40)

    def fit(text: str, make, start: int) -> ImageFont.FreeTypeFont:
        """从 start 号字起递减，直到文本宽度不超出左右 80px 安全区。"""
        size = start
        while size > 24:
            f = make(size)
            if d.textlength(text, font=f) <= W - 160:
                return f
            size -= 2
        return make(24)

    sub_font = fit(SUBTITLE, cjk_font, 42)
    note_font = fit(NOTE, cjk_font, 32)

    draw_tracked(d, (80, 84), KICKER, kicker_font, ACCENT, tracking=10)
    d.text((76, 160), TITLE, font=title_font, fill=TEXT)
    d.text((80, 322), SUBTITLE, font=sub_font, fill=MUTED)

    # 底行：琥珀短杠 + 域名（左），说明（右）
    d.rectangle([78, 534, 174, 546], fill=ACCENT)
    d.text((205, 518), DOMAIN, font=domain_font, fill=TEXT)
    note_w = d.textlength(NOTE, font=note_font)
    d.text((W - 80 - note_w, 524), NOTE, font=note_font, fill=MUTED)

    img.save(OUT, "PNG", optimize=True)
    print(f"written: {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

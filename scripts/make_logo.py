"""
Rebuilds assets/logo.png: keeps the existing shield/house/pin icon from
assets/logo.jpg, but re-renders the "LEADSENTRY" wordmark in the Syncopate
font (fonts/Syncopate-Bold.ttf) instead of the original baked-in font.

Run: python scripts/make_logo.py
Output: assets/logo.png
"""

from PIL import Image, ImageDraw, ImageFont

SRC = "assets/logo.jpg"
OUT = "assets/logo.png"
FONT_PATH = "fonts/Syncopate-Bold.ttf"
NAVY = (13, 36, 69)
SENTRY_BLUE = (0x42, 0x85, 0xF4)  # #4285f4
TEXT = "LeadSentry"
SPLIT_AT = len("Lead")  # characters before this index are NAVY, from here on are SENTRY_BLUE


def color_for(index: int):
    return NAVY if index < SPLIT_AT else SENTRY_BLUE

TARGET_TEXT_WIDTH = 2200  # px, wider than the original wordmark to fit Syncopate's signature tracking
TRACKING_EM = 0.22  # extra space between letters, as a fraction of font size (Syncopate's usual look)
GAP_ABOVE_TEXT = 90
BOTTOM_PADDING = 150
ICON_CROP_HEIGHT = 1150  # icon occupies roughly y=0..1101 in the source; a little padding after

im = Image.open(SRC).convert("RGB")
w, h = im.size
icon = im.crop((0, 0, w, ICON_CROP_HEIGHT))


def tracked_text_width(font: ImageFont.FreeTypeFont, tracking_px: float) -> float:
    d = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    total = 0.0
    for ch in TEXT:
        total += d.textlength(ch, font=font) + tracking_px
    return total - tracking_px  # no trailing tracking after the last glyph


def text_size(size: int):
    font = ImageFont.truetype(FONT_PATH, size)
    tracking_px = size * TRACKING_EM
    width = tracked_text_width(font, tracking_px)
    bbox = ImageDraw.Draw(Image.new("RGB", (10, 10))).textbbox((0, 0), TEXT, font=font)
    return width, bbox[3] - bbox[1], font, bbox, tracking_px


lo, hi = 50, 800
while hi - lo > 1:
    mid = (lo + hi) // 2
    width, *_ = text_size(mid)
    if width < TARGET_TEXT_WIDTH:
        lo = mid
    else:
        hi = mid
text_w, text_h, font, bbox, tracking_px = text_size(lo)
text_w = int(round(text_w))

text_canvas_h = text_h + 40
text_img = Image.new("RGBA", (text_w + 40, text_canvas_h), (255, 255, 255, 0))
d = ImageDraw.Draw(text_img)
x = 20.0
y = 20 - bbox[1]
for i, ch in enumerate(TEXT):
    d.text((x, y), ch, font=font, fill=(*color_for(i), 255))
    x += d.textlength(ch, font=font) + tracking_px

total_h = ICON_CROP_HEIGHT + GAP_ABOVE_TEXT + text_canvas_h + BOTTOM_PADDING
canvas = Image.new("RGB", (w, total_h), "white")
canvas.paste(icon, (0, 0))
text_x = (w - text_img.width) // 2
text_y = ICON_CROP_HEIGHT + GAP_ABOVE_TEXT
canvas.paste(text_img, (text_x, text_y), text_img)

canvas.save(OUT)
print(f"wrote {OUT} ({canvas.size[0]}x{canvas.size[1]}), font size={lo}, text width={text_w}")

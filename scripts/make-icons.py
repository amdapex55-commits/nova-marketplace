#!/usr/bin/env python3
"""Generates the favicons, PWA icons and the social share card.

    python3 scripts/make-icons.py

Why this matters more than it looks: the whole acquisition plan is Instagram,
Facebook and links passed around on WhatsApp. A link with no icon and no preview
card renders in those apps as a bare grey box — which, for a shop asking for a
home address and a phone number, reads as a scam. The share card IS part of the
checkout funnel.

The mark is the product: two swipe cards, one behind the other.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "public"

EMERALD = (20, 97, 74, 255)
EMERALD_DEEP = (14, 70, 54, 255)
MARIGOLD = (224, 160, 16, 255)
PAPER = (255, 255, 255, 255)
MIST = (207, 227, 219, 255)


def font(size: int, bold: bool = True):
    """System faces only — this script must run with nothing installed."""
    for path in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/SFNS.ttf",
    ):
        try:
            return ImageFont.truetype(path, size, index=1 if bold and path.endswith(".ttc") else 0)
        except OSError:
            continue
    return ImageFont.load_default()


def mark(size: int) -> Image.Image:
    """Two stacked cards. Kept geometric so it survives being shown at 16px."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = size / 100

    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(22 * s), fill=EMERALD)

    # Back card, peeking out top-right.
    d.rounded_rectangle(
        [int(38 * s), int(20 * s), int(76 * s), int(72 * s)], radius=int(7 * s), fill=MARIGOLD
    )
    # Front card.
    d.rounded_rectangle(
        [int(24 * s), int(28 * s), int(62 * s), int(80 * s)], radius=int(7 * s), fill=PAPER
    )
    # The dot: the tap target, and the full stop in the wordmark.
    d.ellipse(
        [int(36 * s), int(58 * s), int(50 * s), int(72 * s)], fill=EMERALD
    )
    return im


def wordmark(d: ImageDraw.ImageDraw, x: int, y: int, size: int) -> None:
    f = font(size)
    d.text((x, y), "nova", font=f, fill=PAPER)
    w = d.textlength("nova", font=f)
    d.text((x + w, y), ".", font=f, fill=MARIGOLD)


def share_card() -> Image.Image:
    """1200x630 — what Instagram, Facebook and WhatsApp show for the link."""
    W, H = 1200, 630
    im = Image.new("RGBA", (W, H), EMERALD)
    d = ImageDraw.Draw(im)

    # A fanned deck on the right, echoing the swipe. Each card is rotated about
    # its own centre and then placed by that centre, so the fan stays inside the
    # frame however the angles are tuned — rotate(expand=True) changes the
    # canvas size, and offsetting by the corner puts cards off the edge.
    CW, CH = 250, 330
    for cx, cy, angle, fill in [
        (880, 330, 13, EMERALD_DEEP),
        (940, 315, 5, MARIGOLD),
        (1000, 300, -4, PAPER),
    ]:
        card = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        ImageDraw.Draw(card).rounded_rectangle([0, 0, CW - 1, CH - 1], radius=20, fill=fill)
        card = card.rotate(angle, expand=True, resample=Image.BICUBIC)
        im.alpha_composite(card, (cx - card.width // 2, cy - card.height // 2))

    wordmark(d, 84, 150, 110)
    d.text((84, 300), "Swipe the best of the", font=font(46, bold=False), fill=MIST)
    d.text((84, 356), "internet.", font=font(46, bold=False), fill=MIST)
    d.text((84, 470), "Cash on delivery  ·  No account needed", font=font(28, bold=False), fill=MIST)

    return im.convert("RGB")


def main() -> None:
    for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
        mark(size).save(OUT / name)

    # .ico carries both sizes: 16 for the tab strip, 32 for everything else.
    mark(64).resize((32, 32), Image.LANCZOS).save(
        OUT / "favicon.ico", sizes=[(16, 16), (32, 32)]
    )

    share_card().save(OUT / "og.png", quality=92)

    # An SVG favicon stays crisp at any size and is what modern browsers prefer.
    (OUT / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n'
        '  <rect width="100" height="100" rx="22" fill="#14614a"/>\n'
        '  <rect x="38" y="20" width="38" height="52" rx="7" fill="#e0a010"/>\n'
        '  <rect x="24" y="28" width="38" height="52" rx="7" fill="#fff"/>\n'
        '  <circle cx="43" cy="65" r="7" fill="#14614a"/>\n'
        "</svg>\n"
    )

    print("icons written to", OUT)


if __name__ == "__main__":
    main()

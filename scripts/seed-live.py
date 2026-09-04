#!/usr/bin/env python3
"""Puts a demo shop with real photographs into the LIVE Supabase project.

    python3 scripts/seed-live.py          # create
    python3 scripts/seed-live.py --clear  # remove everything it made

Why this exists: the buyer app now reads the database, so an empty project shows
an empty deck and nothing can be checked end to end. This creates one approved
shop with real WebP photographs in Storage — the same shape a seller would
produce through the workspace.

Everything it makes is tagged with the marker below so --clear can find it. It
never touches rows it did not create.

Uses curl rather than urllib: Python's SSL store on this Mac cannot verify
Supabase's certificate chain.
"""
import json, os, re, subprocess, sys, tempfile
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw

REF = "fvmgouzjfikhmjfbgtgx"
API = f"https://{REF}.supabase.co"
MARKER = "demo-seed"          # written into sellers.brand_name suffix

ROOT = Path(__file__).resolve().parents[1]


def token() -> str:
    line = re.search(r"SUPABASE_ACCESS_TOKEN=(.*)", (Path.home() / ".zshrc").read_text())
    return line.group(1).strip().strip("\"'")


def secret_key(pat: str) -> str:
    out = curl(["-H", f"Authorization: Bearer {pat}",
                f"https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true"])
    for k in json.loads(out):
        if (k.get("api_key") or "").startswith("sb_secret_"):
            return k["api_key"]
    sys.exit("no secret key")


def curl(args: list[str], tries: int = 3) -> str:
    # Seoul is a long way away and the odd request simply times out. Retrying is
    # the difference between a seeder that works and one that half-works and
    # leaves rows behind.
    last = ""
    for attempt in range(tries):
        r = subprocess.run(["curl", "-sS", "-m", "45", "--retry", "2", "--retry-delay", "2", *args],
                           capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout
        last = r.stderr
        print(f"    retrying ({attempt + 1}/{tries})…", file=sys.stderr)
    sys.exit(f"curl failed after {tries} tries: {last[:400]}")


def sql(pat: str, query: str):
    out = curl(["-X", "POST", "-H", f"Authorization: Bearer {pat}",
                "-H", "Content-Type: application/json",
                "-d", json.dumps({"query": query}),
                f"https://api.supabase.com/v1/projects/{REF}/database/query"])
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        sys.exit(f"sql failed: {out[:400]}")


PRODUCTS = [
    ("Ajrak Block-Print Kurta",  "clothing",  3400, 8,  (196, 92, 58),  (34, 58, 52)),
    ("Chikankari Cotton Shirt",  "clothing",  4200, 5,  (238, 231, 214), (140, 132, 110)),
    ("Indigo Straight-Leg Jeans","clothing",  5600, 6,  (44, 62, 108),  (22, 30, 56)),
    ("Khaddar Winter Shawl",     "clothing",  4500, 4,  (122, 74, 52),  (58, 40, 32)),
    ("Kashmiri Chai Blend 250g", "food",      1250, 20, (172, 88, 74),  (68, 34, 30)),
    ("Hunza Apricot Preserve",   "food",      1800, 12, (222, 148, 44), (96, 60, 20)),
    ("Riso-Printed Quarterly 12","magazines",  950, 15, (86, 108, 168), (30, 40, 72)),
    ("Trail Running Tee",        "sports",    2900, 9,  (46, 122, 96),  (20, 58, 46)),
]


def artwork(title: str, base, deep, seed: int) -> bytes:
    """A plausible product photograph, not a logo: soft ground, a subject shape,
    a shadow. Enough for the deck to be judged on layout and rhythm."""
    W, H = 1200, 1500
    im = Image.new("RGB", (W, H), deep)
    d = ImageDraw.Draw(im)
    for y in range(H):                       # vertical wash
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(deep[i] + (base[i] - deep[i]) * t) for i in range(3)))
    cx, cy = W // 2, int(H * 0.52)
    d.ellipse([cx - 330, cy - 300, cx + 330, cy + 420], fill=tuple(max(0, c - 26) for c in deep))
    d.ellipse([cx - 300, cy - 340, cx + 300, cy + 380],
              fill=tuple(min(255, c + 34) for c in base))
    d.ellipse([cx - 150 + (seed % 60), cy - 250, cx + 60 + (seed % 60), cy - 40],
              fill=tuple(min(255, c + 78) for c in base))
    buf = BytesIO()
    im.save(buf, "WEBP", quality=82)
    return buf.getvalue()


def variants(raw: bytes) -> dict[str, bytes]:
    src = Image.open(BytesIO(raw))
    out = {}
    for name, width in (("thumb", 400), ("card", 800), ("full", 1600)):
        w = min(width, src.width)
        img = src.resize((w, round(w * src.height / src.width)), Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, "WEBP", quality=78 if name != "full" else 82)
        out[name] = buf.getvalue()
    return out


def seed_products(pat, key, seller):
    # Resume on TITLE + PHOTO, not title alone. A run that dies mid-upload leaves
    # a product row with no photograph, and every read path now hides those — so
    # a title-only check would skip the very row that needs repairing and the
    # listing would stay invisible forever.
    existing = {r["title"] for r in sql(pat, f"""
        select p.title from products p
         where p.seller_id = '{seller}'
           and exists (select 1 from photos ph where ph.product_id = p.id);""")}

    orphans = sql(pat, f"""
        delete from products p
         where p.seller_id = '{seller}'
           and not exists (select 1 from photos ph where ph.product_id = p.id)
        returning p.title;""")
    for o in orphans:
        print(f"  repairing {o['title']} — had no photograph")

    for i, (title, interest, price, stock, base, deep) in enumerate(PRODUCTS):
        if title in existing:
            print(f"  {title} (already there)")
            continue
        pid = sql(pat, f"""
          insert into products (seller_id, title, description, price, interest, city, stock, status, tags)
          values ('{seller}', $${title}$$,
                  $$Made in small runs by Saanjh Handloom in Lahore. Ships in 1-2 working days.$$,
                  {price}, '{interest}', 'Lahore', {stock}, 'live', array['{interest}'])
          returning id;""")[0]["id"]

        photo_id = os.urandom(8).hex()
        base_key = f"{seller}/{pid}/{photo_id}"
        for name, blob in variants(artwork(title, base, deep, i)).items():
            with tempfile.NamedTemporaryFile(suffix=".webp", delete=False) as f:
                f.write(blob)
                tmp = f.name
            curl(["-X", "POST", f"{API}/storage/v1/object/product-photos/{base_key}-{name}.webp",
                  "-H", f"apikey: {key}", "-H", f"Authorization: Bearer {key}",
                  "-H", "Content-Type: image/webp", "-H", "x-upsert: true",
                  "--data-binary", f"@{tmp}"])
            os.unlink(tmp)
        sql(pat, f"insert into photos (product_id, position, key, width, height) "
                 f"values ('{pid}', 0, '{base_key}', 1600, 2000);")
        print(f"  {title}")



def main():
    pat = token()
    key = secret_key(pat)

    if "--clear" in sys.argv:
        keys = [r["name"] for r in sql(pat,
            f"select name from storage.objects where bucket_id='product-photos';")]
        if keys:
            curl(["-X", "DELETE", f"{API}/storage/v1/object/product-photos",
                  "-H", f"apikey: {key}", "-H", f"Authorization: Bearer {key}",
                  "-H", "Content-Type: application/json",
                  "-d", json.dumps({"prefixes": keys})])
        sql(pat, f"delete from products where seller_id in "
                 f"(select id from sellers where brand_name like '%{MARKER}%');"
                 f"delete from seller_contacts where seller_id in "
                 f"(select id from sellers where brand_name like '%{MARKER}%');"
                 f"delete from sellers where brand_name like '%{MARKER}%';")
        print("cleared")
        return

    brand = f"Saanjh Handloom ({MARKER})"
    found = sql(pat, f"select id from sellers where brand_name = $${brand}$$;")
    if found:
        seller = found[0]["id"]
        print("seller", seller, "(existing)")
        return seed_products(pat, secret_key(pat), seller)

    rows = sql(pat, f"""
      with s as (insert into sellers (brand_name, city, status)
                 values ('{brand}', 'Lahore', 'active') returning id),
           c as (insert into seller_contacts (seller_id, user_id, owner_name, phone, address)
                 select id, gen_random_uuid(), 'Zoya Malik', '03211112222', 'Shop 12, Hussain Agahi' from s
                 returning seller_id)
      select id from s;""")
    seller = rows[0]["id"]
    print("seller", seller)

    return seed_products(pat, key, seller)

    n = sql(pat, "select count(*) c from products where status='live';")[0]["c"]
    print(f"{n} live listings")


if __name__ == "__main__":
    main()

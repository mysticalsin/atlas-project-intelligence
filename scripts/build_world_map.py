#!/usr/bin/env python3
"""Build assets/geo/world-110m.json from hash-pinned Natural Earth v5.1.2 data (public domain).

Standard library only, deterministic (same inputs -> byte-identical output), no timestamps.
  python3 scripts/build_world_map.py --src DIR     # offline: DIR holds the two pinned .geojson files
  python3 scripts/build_world_map.py               # downloads the pinned v5.1.2 files from GitHub
  python3 scripts/build_world_map.py --src DIR --check   # exit 1 if the committed asset differs
Shapes come from 1:110m; 1:50m is read only for small-territory marker points and names.
Mercator, Antarctica dropped, latitude clipped to -58..84, width 1000, 0.1-unit precision
(absolute coordinates are rounded before relative path encoding, so errors never accumulate).
Natural Earth draws de facto boundaries; see docs/THIRD_PARTY.md.
"""
import argparse, hashlib, json, math, sys, unicodedata, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/geo/world-110m.json'
GENERATOR_VERSION = '1.0.0'
TAG = 'v5.1.2'
BASE_URL = f'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/{TAG}/geojson/'
SOURCES = {  # role -> (file, pinned SHA-256)
    'shapes': ('ne_110m_admin_0_countries.geojson', '6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f'),
    'small': ('ne_50m_admin_0_countries.geojson', '3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb'),
}
W, LAT, DROP, Q = 1000, (-58.0, 84.0), {'ATA'}, 10  # Q: stored precision is 1/Q units
TINY_AREA = 12.0  # units^2: 110m countries whose largest ring is smaller also get a marker (e.g. LUX)
NAME_FIELDS = ('NAME', 'NAME_LONG', 'NAME_EN', 'ADMIN', 'FORMAL_EN', 'NAME_ALT',
               'NAME_FR', 'NAME_DE', 'NAME_ES', 'NAME_IT', 'NAME_NL', 'NAME_PT')
DISPLAY = {'CHN': 'China', 'CYN': 'Northern Cyprus', 'USA': 'United States'}  # NAME_EN otherwise

# Curated gazetteer facts (not Natural Earth data). Keys are ADM0_A3; values are normalized by norm().
EXTRA = {
    'GBR': 'uk|u k|great britain|britain|england|scotland|wales|northern ireland|angleterre|ecosse|pays de galles|'
           'irlande du nord|grande bretagne|grossbritannien|schottland|nordirland|inglaterra|escocia|pais de gales|'
           'irlanda del norte|gran bretana|inghilterra|scozia|galles|irlanda del nord|gran bretagna|engeland|'
           'schotland|noord ierland|groot brittannie|gra bretanha|irlanda do norte',
    'USA': 'usa|u s a|united states|united states of america|etats unis|etats unis d amerique|vereinigte staaten|'
           'estados unidos|stati uniti|verenigde staten',
    'ARE': 'uae|u a e|emirates|united arab emirates|emirats arabes unis',
    'SAU': 'ksa|saudi|saudi arabia|arabie saoudite',
    'NLD': 'holland|the netherlands|nederland|pays bas|niederlande|paises bajos|paesi bassi|paises baixos|holanda|hollande',
    'CZE': 'czechia|czech republic|cesko|ceska republika|tchequie|republique tcheque|tschechien|republica checa|repubblica ceca',
    'CIV': 'ivory coast|cote d ivoire|costa de marfil|costa d avorio|costa do marfim',
    'TUR': 'turkiye|turquie|turkei',
    'MMR': 'burma|birmanie|birma',
    'SWZ': 'swaziland|eswatini',
    'MKD': 'macedonia|north macedonia|macedoine|macedoine du nord|nordmazedonien|mazedonien|macedonia del norte|'
           'macedonia del nord|noord macedonie|macedonia do norte',
    'KOR': 'south korea|republic of korea|korea republic of|korea republic|korea south|rok|coree du sud|sudkorea|'
           'corea del sur|corea del sud|zuid korea|coreia do sul',
    'PRK': 'north korea|dprk|democratic people s republic of korea|korea dpr|korea north|'
           'korea democratic people s republic of|coree du nord|nordkorea|corea del norte|corea del nord|noord korea|coreia do norte',
    'COD': 'dr congo|d r congo|drc|rdc|rd congo|r d congo|democratic republic of congo|democratic republic of the congo|'
           'congo kinshasa|congo democratic republic|congo democratic republic of|congo democratic republic of the|'
           'republique democratique du congo|demokratische republik kongo',
    'COG': 'republic of congo|republic of the congo|congo brazzaville|congo republic|congo republic of|congo rep|'
           'republique du congo|republik kongo',
    'NOR': 'norge', 'DNK': 'danmark', 'FIN': 'suomi', 'SWE': 'sverige', 'HRV': 'hrvatska', 'SVK': 'slovensko',
    'SVN': 'slovenija', 'GRC': 'hellas|ellada|hellenic republic', 'AUT': 'osterreich|oesterreich',
    'BEL': 'belgie|belgique|belgien', 'CHE': 'schweiz|suisse|svizzera|swiss confederation', 'LUX': 'letzebuerg|luxemburg',
    'MAR': 'maroc', 'TUN': 'tunisie', 'DZA': 'algerie', 'RUS': 'russian federation|russie|russland|rossiya',
    'VNM': 'viet nam', 'CHN': 'mainland china|prc', 'TWN': 'republic of china|chinese taipei',
    'HKG': 'hong kong sar|hongkong', 'MAC': 'macao|macau|macao sar|macau sar', 'POL': 'polska', 'HUN': 'magyarorszag',
    'SRB': 'srbija', 'EST': 'eesti', 'LVA': 'latvija', 'LTU': 'lietuva', 'IRL': 'eire|republic of ireland',
    'UKR': 'ukraina', 'BIH': 'bosnia', 'TLS': 'east timor|timor leste', 'CPV': 'cape verde|cabo verde',
    'SGS': 'south georgia', 'VIR': 'us virgin islands|u s virgin islands', 'VGB': 'bvi',
    'PSX': 'state of palestine|palestinian territories', 'VAT': 'holy see|vatican city', 'LAO': 'lao pdr',
    'BRN': 'brunei darussalam', 'SYR': 'syrian arab republic', 'MDA': 'republic of moldova', 'FSM': 'micronesia',
    'ESP': 'espana|espagne', 'DEU': 'deutschland|allemagne', 'ITA': 'italia',
}
# Alias strings that are ordinary words or better-known places elsewhere: never matched.
DROP_ALIASES = {'island', 'granada', 'man', 'guiana', 'oma', 'salvador', 'norfolk', 'america'}
# Phrases that name no single country: reported as ambiguous with these choices.
AMBIGUOUS = {
    'congo': ['COD', 'COG'], 'kongo': ['COD', 'COG'],
    'korea': ['KOR', 'PRK'], 'coree': ['KOR', 'PRK'], 'corea': ['KOR', 'PRK'], 'coreia': ['KOR', 'PRK'],
    'saint martin': ['MAF', 'SXM'], 'st martin': ['MAF', 'SXM'], 'san martin': ['MAF', 'SXM'], 'sao martinho': ['MAF', 'SXM'],
    'new guinea': ['IDN', 'PNG'], 'nouvelle guinee': ['IDN', 'PNG'], 'neuguinea': ['IDN', 'PNG'],
    'nueva guinea': ['IDN', 'PNG'], 'nuova guinea': ['IDN', 'PNG'], 'nieuw guinea': ['IDN', 'PNG'],
    'virgin islands': ['VGB', 'VIR'], 'iles vierges': ['VGB', 'VIR'], 'timor': ['IDN', 'TLS'],
}
OVERRIDE = {'sint maarten': 'SXM'}  # an NE collision with one clear English meaning
# Phrases that contain a country alias but are not that country: consumed and reported unresolved.
FALSE_FRIENDS = ['new south wales', 'nouvelle galles du sud', 'nueva gales del sur', 'nuovo galles del sud',
                 'nieuw zuid wales', 'nova gales do sul', 'new england', 'nouvelle angleterre', 'nueva inglaterra',
                 'jersey city', 'french guiana', 'guyane francaise', 'guyana francese', 'frans guyana',
                 'guayana francesa', 'guiana francesa', 'baja california']
# US context. 'Georgia' reads as the country only when none of this appears in the same field.
US_STATES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
             'florida', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
             'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana',
             'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
             'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
             'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
             'wisconsin', 'wyoming', 'district of columbia', 'washington dc', 'washington d c']
US_CITIES = ['atlanta', 'savannah', 'augusta', 'macon', 'alpharetta', 'marietta']  # Georgia (US state) cities
ABBREVIATIONS = {'US': 'USA', 'U S': 'USA'}  # case-sensitive raw tokens: lowercase 'us' is a word
SPECIAL = {'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'œ': 'oe', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ŀ': 'l'}


def norm_token(t):
    """Mirror of geo.js normToken: lower, NFKD, strip marks, fold special letters, keep [a-z0-9]."""
    t = ''.join(c for c in unicodedata.normalize('NFKD', t.lower()) if not unicodedata.category(c).startswith('M'))
    t = ''.join(SPECIAL.get(c, c) for c in t)
    return ''.join(c for c in t if c in 'abcdefghijklmnopqrstuvwxyz0123456789')


def norm(s):
    """Mirror of geo.js tokenization: runs of letters/marks/digits, '&' becomes 'and'."""
    toks, cur = [], ''
    for c in s:
        if unicodedata.category(c)[0] in 'LMN':
            cur += c
            continue
        if cur:
            toks.append(cur)
            cur = ''
        if c == '&':
            toks.append('and')
    if cur:
        toks.append(cur)
    return ' '.join(n for n in (norm_token(t) for t in toks) if n)


def load(src, role):
    name, want = SOURCES[role]
    if src:
        data = (Path(src) / name).read_bytes()
    else:
        with urllib.request.urlopen(BASE_URL + name, timeout=120) as r:
            data = r.read()
    got = hashlib.sha256(data).hexdigest()
    if got != want:
        sys.exit(f'Refusing to build: SHA-256 mismatch for {name}\n  expected {want}\n  got      {got}')
    return name, data


def check(ok, message):
    """Data-integrity guard that survives python -O (unlike assert)."""
    if not ok:
        sys.exit(f'Refusing to build: {message}')


def merc_y(lat):
    return -math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


K = W / (2 * math.pi)
Y0 = merc_y(LAT[1])
H = round((merc_y(LAT[0]) - Y0) * K)


def project(lon, lat):
    return (math.radians(lon) + math.pi) * K, (merc_y(lat) - Y0) * K


def clip_lat(ring):
    """Sutherland-Hodgman against the two latitude limits (in lon/lat space)."""
    for lim, keep in ((LAT[0], lambda y: y >= LAT[0]), (LAT[1], lambda y: y <= LAT[1])):
        out = []
        for i in range(len(ring)):
            (x1, y1), (x2, y2) = ring[i - 1], ring[i]
            a, b = keep(y1), keep(y2)
            if a != b:
                out.append((x1 + (x2 - x1) * (lim - y1) / (y2 - y1), lim))
            if b:
                out.append((x2, y2))
        ring = out
        if not ring:
            break
    return ring


def ring_points(ring):
    pts = []
    for lon, lat in clip_lat([tuple(p[:2]) for p in ring]):
        x, y = project(lon, lat)
        p = (round(x * Q), round(y * Q))
        if not pts or p != pts[-1]:
            pts.append(p)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts if len(pts) >= 3 else None


def num(v):
    """Integer tenths -> shortest decimal text ('12', '12.5', '.5', '-.5')."""
    i, f = divmod(abs(v), Q)
    return ('-' if v < 0 else '') + (str(i) if f == 0 else (str(i) if i else '') + '.' + str(f))


def unit(v):
    return v // Q if v % Q == 0 else v / Q


def ring_path(pts):
    body = ''
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        for d in (bx - ax, by - ay):
            t = num(d)
            body += t if not body or t[0] == '-' else ' ' + t
    return 'M' + num(pts[0][0]) + ' ' + num(pts[0][1]) + 'l' + body + 'z'


def area(pts):
    return abs(sum(ax * by - bx * ay for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]))) / 2 / (Q * Q)


def polygons(geom):
    return [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']


def inside(lon, lat, geom):
    """Even-odd point-in-polygon over all rings (holes included)."""
    hit = False
    for poly in polygons(geom):
        for ring in poly:
            for i in range(len(ring)):
                (x1, y1), (x2, y2) = ring[i - 1][:2], ring[i][:2]
                if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                    hit = not hit
    return hit


def point(lon, lat):
    x, y = project(lon, min(max(lat, LAT[0]), LAT[1]))
    return [unit(round(x * Q)), unit(round(y * Q))]


def build(src):
    loaded = {role: load(src, role) for role in SOURCES}
    small = json.loads(loaded['small'][1])['features']
    shapes = [f for f in json.loads(loaded['shapes'][1])['features'] if f['properties']['ADM0_A3'] not in DROP]
    props = {f['properties']['ADM0_A3']: [f['properties']] for f in shapes}
    for f in small:
        code = f['properties']['ADM0_A3']
        if code not in DROP:
            props.setdefault(code, []).append(f['properties'])
    check(len(props) == 241, f'expected 241 admin-0 units without Antarctica, got {len(props)}')
    shape_codes = {f['properties']['ADM0_A3'] for f in shapes}
    check(len(shape_codes) == len(shapes), 'duplicate ADM0_A3 in 1:110m')

    # Geometry: path, main box (largest ring, so France ignores French Guiana), label point.
    geo, markers = {}, {}
    for f in shapes:
        p = f['properties']
        code = p['ADM0_A3']
        rings = [pts for poly in polygons(f['geometry']) for pts in map(ring_points, poly) if pts]
        main = max((pts for poly in polygons(f['geometry']) for pts in [ring_points(poly[0])] if pts), key=area)
        xs, ys = [x for x, _ in main], [y for _, y in main]
        label = point(p['LABEL_X'], p['LABEL_Y'])
        geo[code] = ([unit(min(xs)), unit(min(ys)), unit(max(xs)), unit(max(ys))], label, ''.join(map(ring_path, rings)))
        if area(main) < TINY_AREA:
            markers[code] = label
    for code, plist in props.items():
        if code not in shape_codes:
            p = plist[-1]
            markers[code] = point(p['LABEL_X'], p['LABEL_Y'])
            geo[code] = (markers[code] * 2, markers[code], '')
    stacked = sorted(f['properties']['ADM0_A3'] for f in shapes if any(
        g is not f and inside(f['properties']['LABEL_X'], f['properties']['LABEL_Y'], g['geometry']) for g in shapes))
    check(not stacked, f'features overlap another feature, so draw order would matter: {stacked}')

    # Codes: accepted by geo.js only when they are the whole field.
    all_codes = set(props)
    a2count = {}
    for plist in props.values():
        a2count[plist[0]['ISO_A2_EH']] = a2count.get(plist[0]['ISO_A2_EH'], 0) + 1
    iso = {}
    for code, plist in props.items():
        p = plist[0]
        a2, a3 = p['ISO_A2_EH'], p['ISO_A3_EH']
        ok2 = a2 != '-99' and (a2count[a2] == 1 or a3 == code)
        ok3 = a3 != '-99' and (a3 == code or a3 not in all_codes)
        iso[code] = (a2 if ok2 else '', a3 if ok3 else '')

    # Aliases: Natural Earth names in EN/FR/DE/ES/IT/NL/PT + curated extras.
    alias = {}
    for code, plist in props.items():
        names = {v for p in plist for k in NAME_FIELDS for v in [p.get(k)] if isinstance(v, str) and v not in ('', '-99')}
        names |= set(EXTRA.get(code, '').split('|')) - {''}
        for v in names:
            a = norm(v)
            variants = {a}
            for x in list(variants):
                if x.startswith('the '):
                    variants.add(x[4:])
            for x in list(variants):
                for long, short in (('saint ', 'st '), ('sainte ', 'ste ')):
                    if x.startswith(long):
                        variants.add(short + x[len(long):])
                    elif x.startswith(short):
                        variants.add(long + x[len(short):])
            for x in variants:
                if x:
                    alias.setdefault(x, set()).add(code)
    for a in DROP_ALIASES:
        alias.pop(a, None)
    for a, code in OVERRIDE.items():
        alias[a] = {code}
    collisions = {a for a, v in alias.items() if len(v) > 1}
    unhandled = collisions - set(AMBIGUOUS)
    check(not unhandled, f'uncurated alias collisions: {sorted(unhandled)}')
    for a in AMBIGUOUS:
        alias.pop(a, None)
        check(all(c in all_codes for c in AMBIGUOUS[a]), f'unknown code in ambiguous entry {a!r}')
    special = set(FALSE_FRIENDS) | set(US_STATES) | set(US_CITIES)
    clash = special & set(alias)
    check(not clash, f'alias also listed as false friend or US place: {sorted(clash)}')
    check(all(norm(x) == x for x in list(special) + list(AMBIGUOUS) + list(alias)), 'curated lists must be normalized')
    by_code = {}
    for a, v in alias.items():
        by_code.setdefault(next(iter(v)), []).append(a)

    countries = {}
    for code in sorted(props):
        p = props[code][0]
        name = DISPLAY.get(code) or p['NAME_EN']
        box, label, path = geo[code]
        countries[code] = [name, iso[code][0], iso[code][1], '|'.join(sorted(by_code.get(code, []))), box, label, path]
    grat = ''.join(f'M{num(round((lon + 180) * W / 360 * Q))} 0V{H}' for lon in range(-180, 181, 10))
    grat += ''.join(f'M0 {num(round(project(0, lat)[1] * Q))}H{W}' for lat in range(-50, 81, 10))
    return {
        'provenance': {
            'dataset': 'Natural Earth', 'version': '5.1.2', 'tag': TAG, 'licence': 'Public domain (Natural Earth terms of use)',
            'sources': [{'role': role, 'file': loaded[role][0], 'url': BASE_URL + loaded[role][0],
                         'sha256': SOURCES[role][1], 'bytes': len(loaded[role][1])} for role in SOURCES],
            'use': '1:110m admin-0 countries for shapes and label points; 1:50m only for small-territory marker points and names',
            'projection': {'name': 'Mercator', 'lon': [-180, 180], 'lat': [LAT[0], LAT[1]], 'width': W, 'height': H,
                           'precision': 1 / Q, 'paths': 'absolute coordinates rounded to 0.1, then relative SVG path commands'},
            'dropped': sorted(DROP),
            'boundaries': 'De facto (Natural Earth). Crimea is inside Russia; at 1:110m the Morocco polygon includes the '
                          'Moroccan-administered west of Western Sahara and a separate Western Sahara feature covers the '
                          'rest; France includes French Guiana; Norway includes Svalbard. Illustrative only.',
            'generator': 'scripts/build_world_map.py', 'generatorVersion': GENERATOR_VERSION,
        },
        'width': W, 'height': H,
        'fields': ['name', 'iso2', 'iso3', 'aliases', 'box', 'label', 'path'],
        'countries': countries,
        'markers': [[code] + markers[code] for code in sorted(markers)],
        'graticule': grat,
        'gazetteer': {
            'abbreviations': ABBREVIATIONS,
            'ambiguous': {a: sorted(AMBIGUOUS[a]) for a in sorted(AMBIGUOUS)},
            'falseFriends': sorted(FALSE_FRIENDS), 'usStates': sorted(US_STATES), 'usCities': sorted(US_CITIES),
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--src', help='directory holding the pinned Natural Earth v5.1.2 .geojson files (no network)')
    ap.add_argument('--out', default=str(OUT), help='output path (default: assets/geo/world-110m.json)')
    ap.add_argument('--check', action='store_true', help='compare with the existing output instead of writing')
    args = ap.parse_args()
    blob = (json.dumps(build(args.src), separators=(',', ':'), ensure_ascii=False) + '\n').encode()
    out = Path(args.out)
    if args.check:
        same = out.exists() and out.read_bytes() == blob
        print(('identical: ' if same else 'DIFFERS: ') + str(out))
        sys.exit(0 if same else 1)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    print(f'Wrote {out} ({len(blob)} bytes, sha256 {hashlib.sha256(blob).hexdigest()})')


if __name__ == '__main__':
    main()

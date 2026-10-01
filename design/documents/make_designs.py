"""Wi-Fi Fiti documents, detailed (v3): signal arcs, ticket stub, dense data, Bricolage Grotesque.

Text is measured with the real Bricolage Grotesque files and placed with
start anchors so Figma imports it exactly where it is drawn, as editable
text. Every shape is a plain rect, circle, line or path that pdfkit can also
draw, so the PDFs can be built to match.
"""
import math
import os
from xml.sax.saxutils import escape
from PIL import ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.environ.get('BRICOLAGE_TTF_DIR', os.path.expanduser('~/.fonts'))
WEIGHTS = {400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold'}
_fonts = {}

def width(s, size, weight=400):
    if weight not in _fonts:
        _fonts[weight] = ImageFont.truetype(os.path.join(FONT_DIR, f'BricolageGrotesque-{WEIGHTS[weight]}.ttf'), 400)
    return _fonts[weight].getlength(s) * size / 400

FAMILY = "'Bricolage Grotesque', sans-serif"
P = dict(
    ink='#0E2A33',       # deep teal-black: text and figures
    muted='#5E7480',     # labels
    line='#DCE7E5',      # hairlines
    paper='#F2F7F6',     # tinted panels
    brand='#007D90',     # header block (a tenant's own color replaces it)
    brand_tint='#E3F2F3',
    mint='#8EE7D1',      # chip on the brand block
    white='#FFFFFF',
    paid='#1E8E5A', pending='#C98A00', failed='#C0392B',
)


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.title, self.parts, self.defs = w, h, title, [], []

    def add(self, s):
        self.parts.append(s)

    def rect(self, x, y, w, h, fill, rx=0, name=None, stroke=None, sw=1, opacity=None):
        a = f' id="{escape(name)}"' if name else ''
        a += f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
        a += f' fill-opacity="{opacity}"' if opacity is not None else ''
        self.add(f'<rect{a} x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx}" fill="{fill}"/>')

    def text(self, x, y, s, size, color, weight=400, align='left', box=None, name=None, spacing=None):
        w = width(s, size, weight)
        if spacing:
            w += spacing * (len(s) - 1)
        if align == 'center':
            tx = x + (box - w) / 2 if box is not None else x - w / 2
        elif align == 'right':
            tx = x + box - w if box is not None else x - w
        else:
            tx = x
        a = f' id="{escape(name)}"' if name else ''
        a += f' letter-spacing="{spacing}"' if spacing else ''
        self.add(f'<text{a} x="{tx:.2f}" y="{y:.2f}" font-family="{FAMILY}" font-size="{size}" font-weight="{weight}" fill="{color}">{escape(s)}</text>')
        return w

    def mark(self, x, y, size, color, name='Wi-Fi mark'):
        k = size / 24
        self.add(f'<g id="{name}" transform="translate({x:.2f} {y:.2f}) scale({k:.4f})" fill="none">'
                 f'<circle cx="12" cy="19.68" r="2.16" fill="{color}"/>'
                 f'<path d="M6.821 14.678A7.2 7.2 0 0 1 17.179 14.678" stroke="{color}" stroke-width="2.4" stroke-linecap="round"/>'
                 f'<path d="M3.368 11.344A12 12 0 0 1 20.632 11.344" stroke="{color}" stroke-width="2.16" stroke-linecap="round"/>'
                 f'<path d="M-0.084 8.009A16.8 16.8 0 0 1 24.084 8.009" stroke="{color}" stroke-width="1.92" stroke-linecap="round"/></g>')

    def arcs(self, cx, cy, radii, color, opacity, sw, clip, name='Signal arcs'):
        """Concentric signal arcs from (cx, cy), clipped to a rectangle."""
        cid = f'clip{len(self.defs)}'
        x, y, w, h, rx = clip
        self.defs.append(f'<clipPath id="{cid}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/></clipPath>')
        rings = ''.join(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="none" stroke="{color}" stroke-opacity="{opacity}" stroke-width="{sw}"/>' for r in radii)
        self.add(f'<g id="{name}" clip-path="url(#{cid})">{rings}</g>')

    def group(self, name):
        self.add(f'<g id="{escape(name)}">')

    def end(self):
        self.add('</g>')

    def save(self, filename):
        defs = f'<defs>{"".join(self.defs)}</defs>\n' if self.defs else ''
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}">\n'
               f'<title>{escape(self.title)}</title>\n{defs}' + '\n'.join(self.parts) + '\n</svg>\n')
        with open(os.path.join(OUT, filename), 'w') as f:
            f.write(svg)
        return filename


STATUS = {'paid': (P['paid'], 'Paid'), 'pending': (P['pending'], 'Waiting for M-Pesa'), 'failed': (P['failed'], 'Not completed'),
          'Paid': (P['paid'], 'Paid'), 'Failed': (P['failed'], 'Failed'), 'Pending': (P['pending'], 'Pending'),
          'Collected': (P['brand'], 'Collected'), 'Waiting for review': (P['pending'], 'Waiting for review')}



# ================================================================== v3: detailed
import random
import sys
sys.path.insert(0, os.environ.get('SEGNO_DIR', os.path.expanduser('~/segno')))
try:
    import segno
except ImportError:  # the QR code is drawn as a placeholder square without it
    segno = None

STATUS.update({'Refunded': ('#6B5BD2', 'Refunded'), 'Fee': (P['muted'], 'Fee'), 'Opening': (P['muted'], 'Opening')})


def blend(a, b, t):
    """Mix colour a toward b by t (0..1)."""
    a = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{round(x + (y - x) * t):02X}' for x, y in zip(a, b))


def hline(s, x1, x2, y, color=None, sw=0.8, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    s.add(f'<line x1="{x1:.1f}" y1="{y:.1f}" x2="{x2:.1f}" y2="{y:.1f}" stroke="{color or P["line"]}" stroke-width="{sw}"{d}/>')


def vline(s, x, y1, y2, color=None, sw=0.8):
    s.add(f'<line x1="{x:.1f}" y1="{y1:.1f}" x2="{x:.1f}" y2="{y2:.1f}" stroke="{color or P["line"]}" stroke-width="{sw}"/>')


def wrap(text, size, weight, max_w):
    lines, cur = [], ''
    for word in text.split():
        trial = (cur + ' ' + word).strip()
        if width(trial, size, weight) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    return lines + ([cur] if cur else [])


def qr(s, x, y, size, data, color):
    if segno is None:
        s.rect(x, y, size, size, P['line'], rx=4, name='QR code')
        return
    matrix = [list(row) for row in segno.make(data, error='m').matrix]
    k = size / len(matrix)
    d = ''.join(f'M{x + c * k:.2f} {y + r * k:.2f}h{k:.2f}v{k:.2f}h-{k:.2f}z'
                for r, row in enumerate(matrix) for c, v in enumerate(row) if v)
    s.add(f'<path id="QR code" d="{d}" fill="{color}"/>')


def chip(s, x, y, text, fill, color, size=8.5, weight=600, dot=None):
    w = width(text, size, weight) + (24 if dot else 16)
    s.rect(x, y, w, size + 9, fill, rx=(size + 9) / 2)
    if dot:
        s.add(f'<circle cx="{x + 10:.1f}" cy="{y + (size + 9) / 2:.1f}" r="2.8" fill="{dot}"/>')
    s.text(x + (17 if dot else 8), y + size + 3.4, text, size, color, weight)
    return w


def money(v, cents=False):
    return f'KES {v:,.2f}' if cents else f'KES {v:,.0f}'


# ------------------------------------------------------------------ receipt
def receipt(filename, title, d):
    brand = d['brand']
    W, m = 360, 24
    soft = blend(brand, '#FFFFFF', 0.72)
    s = Svg(W, 1000, title)
    s.group('Ticket')
    paper_at = len(s.parts)
    s.add('')
    head_h = 214

    s.group('Brand block')
    s.add(f'<path id="Block" d="M0 18A18 18 0 0 1 18 0H{W - 18}A18 18 0 0 1 {W} 18V{head_h}H0Z" fill="{brand}"/>')
    s.arcs(W - 14, head_h + 14, [36, 66, 96, 126, 156, 186], P['white'], 0.12, 10, (0, 0, W, head_h, 0))
    s.mark(m, 22, 20, P['white'])
    s.text(m + 28, 34, d['name'], 13, P['white'], 700, name='Business name')
    s.text(m + 28, 49, d['place'], 9, soft, 500, name='Place')
    s.text(m, 34, d['number'], 9, P['white'], 600, align='right', box=W - 2 * m, name='Receipt number')
    s.text(m, 49, d['when'], 9, soft, 500, align='right', box=W - 2 * m)
    s.text(m, 86, d['amount_label'], 10, soft, 500)
    s.text(m, 134, d['amount'], 50, P['white'], 800, name='Amount')
    color, label = STATUS[d['state']]
    chip_fill = P['mint'] if d['state'] == 'paid' else '#FFE7A8'
    cw = chip(s, m, 150, label, chip_fill, P['ink'], 10, 600, dot=color)
    s.text(m + cw + 10, 163.5, d['subtitle'], 10, P['white'], 600)
    if d.get('saved'):
        s.rect(m, 182, W - 2 * m, 18, blend(brand, '#000000', 0.18), rx=9)
        s.text(m + 10, 194.5, d['saved'], 8.5, P['white'], 500)
    s.end()

    s.group('Perforation')
    py = head_h + 16
    s.add(f'<circle cx="0" cy="{py}" r="9" fill="{P["paper"]}"/><circle cx="{W}" cy="{py}" r="9" fill="{P["paper"]}"/>')
    hline(s, 16, W - 16, py, P['line'], 1.4, '4 4')
    s.end()

    y = head_h + 50
    for section in d['sections']:
        s.group(section['title'])
        tw = s.text(m, y, section['title'], 11, P['ink'], 700)
        hline(s, m + tw + 10, W - m, y - 3.5)
        y += 21
        for item in section['items']:
            kind = item[0]
            if kind in ('row', 'code', 'minus'):
                _, label, value = item
                s.text(m, y, label, 9.5, P['muted'], 400)
                tone = P['paid'] if kind == 'minus' else P['ink']
                s.text(m, y, value, 9.5, tone, 600, align='right', box=W - 2 * m, spacing=0.6 if kind == 'code' else None)
                y += 19
            elif kind == 'bar':
                _, label, value, frac = item
                s.text(m, y, label, 9.5, P['muted'], 400)
                s.text(m, y, value, 9.5, P['ink'], 600, align='right', box=W - 2 * m)
                s.rect(m, y + 7, W - 2 * m, 6, P['brand_tint'], rx=3)
                s.rect(m, y + 7, max((W - 2 * m) * frac, 6), 6, brand, rx=3)
                y += 30
            elif kind == 'total':
                _, label, value = item
                hline(s, m, W - m, y - 11, P['ink'], 1.2)
                y += 6
                s.text(m, y, label, 11, P['ink'], 700)
                s.text(m, y + 1, value, 15, brand, 800, align='right', box=W - 2 * m)
                y += 22
            elif kind == 'note':
                for line in wrap(item[1], 8.5, 400, W - 2 * m):
                    s.text(m, y, line, 8.5, P['muted'], 400)
                    y += 12
                y += 4
        s.end()
        y += 12

    if d.get('recovery'):
        code, note = d['recovery']
        s.group('Recovery code')
        lines = wrap(note, 8.5, 400, W - 2 * m - 186)
        h = max(78, 30 + 12 * len(lines))
        s.rect(m, y, W - 2 * m, h, P['paper'], rx=12)
        s.rect(m, y, 5, h, brand, rx=2.5)
        s.text(m + 18, y + 22, 'Recovery code', 9, P['muted'], 600)
        s.text(m + 18, y + 54, code, 26, P['ink'], 800, spacing=3)
        for i, line in enumerate(lines):
            s.text(m + 168, y + 22 + 12 * i, line, 8.5, P['muted'], 400)
        s.end()
        y += h + 22

    if d.get('steps'):
        s.group('Steps')
        tw = s.text(m, y, d['steps'][0], 11, P['ink'], 700)
        hline(s, m + tw + 10, W - m, y - 3.5)
        y += 20
        for i, step in enumerate(d['steps'][1]):
            s.add(f'<circle cx="{m + 8}" cy="{y - 3.5}" r="8" fill="{brand}"/>')
            s.text(m, y, str(i + 1), 9, P['white'], 700, align='center', box=16)
            lines = wrap(step, 9, 400, W - 2 * m - 26)
            for j, line in enumerate(lines):
                s.text(m + 26, y + 12 * j, line, 9, P['ink'], 400)
            y += 12 * len(lines) + 10
        s.end()
        y += 10

    if d.get('qr'):
        url, head, note = d['qr']
        s.group('Online copy')
        s.rect(m, y, W - 2 * m, 104, P['white'], rx=12, stroke=P['line'], sw=1)
        qr(s, m + 12, y + 12, 80, url, P['ink'])
        s.text(m + 108, y + 30, head, 10.5, P['ink'], 700)
        for i, line in enumerate(wrap(note, 8.5, 400, W - 2 * m - 120)):
            s.text(m + 108, y + 46 + 12 * i, line, 8.5, P['muted'], 400)
        s.text(m + 108, y + 88, url.replace('https://', ''), 8.5, brand, 600)
        s.end()
        y += 104 + 22

    s.group('Footer')
    hline(s, m, W - m, y)
    y += 18
    cols = d['contacts']
    cw2 = (W - 2 * m) / len(cols)
    for i, (label, value) in enumerate(cols):
        s.text(m + i * cw2, y, label, 8, P['muted'], 500)
        s.text(m + i * cw2, y + 13, value, 8.5, P['ink'], 600)
    y += 32
    s.mark(m, y - 9, 12, brand, name='Footer mark')
    s.text(m + 17, y, d['footer'], 8, P['muted'], 500)
    s.text(m, y, d['printed'], 8, P['muted'], 400, align='right', box=W - 2 * m)
    s.end()
    s.end()
    s.h = int(y + 22)
    s.parts[paper_at] = f'<rect id="Paper" x="0" y="0" width="{W}" height="{s.h}" rx="18" fill="{P["white"]}"/>'
    return s.save(filename)


# ------------------------------------------------------------------ report pieces
def page(s, W, H, brand, brand_name, doc_title, period, generated, filters, m):
    s.rect(0, 0, W, H, P['white'], name='Page')
    s.rect(0, 0, W, 6, brand, name='Brand edge')
    s.arcs(W + 10, -40, [70, 110, 150, 190], brand, 0.10, 14, (0, 6, W, 96, 0))
    s.group('Heading')
    s.mark(m, 26, 15, brand)
    s.text(m + 21, 37, brand_name, 10.5, P['ink'], 700, name='Business')
    s.text(m + 21 + width(brand_name, 10.5, 700) + 8, 37, 'Business ID WF-20417', 9, P['muted'], 400)
    s.text(m, 74, doc_title, 28, P['ink'], 800, name='Title')
    s.text(m, 37, period, 10.5, P['ink'], 700, align='right', box=W - 2 * m, name='Period')
    s.text(m, 51, generated, 8.5, P['muted'], 400, align='right', box=W - 2 * m)
    s.text(m, 63, 'Compared with the 30 days before', 8.5, P['muted'], 400, align='right', box=W - 2 * m)
    x = m
    for f in filters:
        x += chip(s, x, 86, f, P['paper'], P['ink'], 8, 500) + 6
    s.end()


def figures(s, x, y, w, items, brand):
    """(label, value, change, good) across a strip of equal columns."""
    s.group('Figures')
    cw = w / len(items)
    for i, (label, value, change, good) in enumerate(items):
        cx = x + i * cw + (0 if i == 0 else 12)
        s.text(cx, y + 10, label, 8.5, P['muted'], 500)
        s.text(cx, y + 34, value, 20 if i == 0 else 15, brand if i == 0 else P['ink'], 800 if i == 0 else 700)
        if change:
            tone = P['paid'] if good else P['failed']
            bg = '#E2F4EA' if good else '#FBE5E2'
            chip(s, cx, y + 41, change, bg, tone, 7.5, 600)
        if i:
            vline(s, x + i * cw, y, y + 56)
    s.end()


def bar_chart(s, x, y, w, h, values, labels, brand, money_axis=True, note=None):
    s.group('Daily chart')
    top = max(values)
    step = 500 if top < 4000 else 1000
    ceiling = math.ceil(top / step) * step
    for k in range(0, ceiling + 1, step * (2 if ceiling / step > 5 else 1)):
        gy = y + h - h * k / ceiling
        hline(s, x + 34, x + w, gy, '#EAF1F0', 0.7)
        s.text(x, gy + 3, f'{k / 1000:g}k' if k else '0', 7.5, P['muted'], 400, align='right', box=28)
    n = len(values)
    slot = (w - 34) / n
    peak = values.index(top)
    avg = sum(values) / n
    for i, v in enumerate(values):
        bh = h * v / ceiling
        col = brand if i == peak else blend(brand, '#FFFFFF', 0.45)
        s.rect(x + 34 + i * slot + slot * 0.18, y + h - bh, slot * 0.64, bh, col, rx=min(2.5, slot * 0.3))
        if labels[i]:
            s.text(x + 34 + i * slot, y + h + 12, labels[i], 7.5, P['muted'], 400, align='center', box=slot)
    ay = y + h - h * avg / ceiling
    hline(s, x + 34, x + w, ay, P['ink'], 0.9, '3 3')
    tag = f'Average {money(avg)} a day'
    tw = width(tag, 7.5, 600) + 10
    s.rect(x + w - tw, ay - 15, tw, 12, P['ink'], rx=6)
    s.text(x + w - tw + 5, ay - 6.3, tag, 7.5, P['white'], 600)
    px = x + 34 + peak * slot + slot / 2
    s.text(px, y + h - h * top / ceiling - 6, note or money(top), 7.5, brand, 700, align='center', box=0)
    s.end()


def share_rows(s, x, y, w, rows, brand, label_w=96, step=20):
    """(label, value text, share 0..1, extra text) with bars."""
    top = max(r[2] for r in rows) or 1
    for label, value, share, extra in rows:
        s.text(x, y, label, 9, P['ink'], 500)
        s.text(x, y, value, 9, P['ink'], 700, align='right', box=w)
        bw = w - label_w - 70
        s.rect(x + label_w, y - 7, bw, 7, P['brand_tint'], rx=3.5)
        s.rect(x + label_w, y - 7, max(bw * share / top, 5), 7, brand, rx=3.5)
        if extra:
            s.text(x + label_w, y + 11, extra, 7.5, P['muted'], 400)
        y += 26 if extra else step
    return y


def heading(s, x, y, text, w, aside=None):
    tw = s.text(x, y, text, 11.5, P['ink'], 700)
    if aside:
        aw = s.text(x, y, aside, 8.5, P['muted'], 400, align='right', box=w)
        hline(s, x + tw + 10, x + w - aw - 10, y - 4)
    else:
        hline(s, x + tw + 10, x + w, y - 4)


def table(s, x, y, w, columns, rows, brand, size=8.5, row_h=19, totals=None):
    total = sum(c[2] for c in columns)
    widths = [c[2] / total * w for c in columns]
    s.group('Table header')
    cx = x
    for (key, label, _, align), cw in zip(columns, widths):
        s.text(cx, y, label, 8, P['muted'], 600, align=align, box=cw - 8)
        cx += cw
    hline(s, x, x + w, y + 7, P['ink'], 1.3)
    s.end()
    y += 7
    s.group('Table rows')
    for n, row in enumerate(rows):
        if n % 2:
            s.rect(x, y, w, row_h, '#F8FBFA')
        y += row_h
        cx = x
        base = y - row_h / 2 + size * 0.36
        for (key, label, _, align), cw in zip(columns, widths):
            value = str(row.get(key, ''))
            if key == 'status' and value in STATUS:
                color, word = STATUS[value]
                s.add(f'<circle cx="{cx + 3:.1f}" cy="{base - size * 0.36:.1f}" r="2.8" fill="{color}"/>')
                s.text(cx + 10, base, word, size, P['ink'], 500)
            else:
                strong = align == 'right' or key in row.get('_strong', ())
                tone = P['muted'] if value in ('—', '') or key in row.get('_muted', ()) else P['ink']
                if key in row.get('_good', ()):
                    tone = P['paid']
                s.text(cx, base, value, size, tone, 600 if strong else 400, align=align, box=cw - 8)
            cx += cw
        hline(s, x, x + w, y, P['line'], 0.6)
    s.end()
    if totals:
        s.group('Totals')
        y += row_h + 2
        hline(s, x, x + w, y - row_h + 2, P['ink'], 1.3)
        cx = x
        for (key, label, _, align), cw in zip(columns, widths):
            if key in totals:
                s.text(cx, y - 4, totals[key], size + 0.5, P['ink'] if key != totals.get('_brand') else brand, 800, align=align, box=cw - 8)
            cx += cw
        s.end()
    return y


def footer(s, W, H, m, notes, page_no='Page 1 of 1'):
    s.group('Footer')
    y = H - 30
    for i, note in enumerate(notes):
        s.text(m, y - 22 - 11 * (len(notes) - 1 - i), note, 7.5, P['muted'], 400)
    hline(s, m, W - m, y - 12)
    s.mark(m, y - 6, 10, P['muted'], name='Footer mark')
    s.text(m + 14, y + 2, 'Billed on Wi-Fi Fiti, M-Pesa hotspot billing. wififiti.co.ke', 7.5, P['muted'], 500)
    s.text(m, y + 2, page_no, 7.5, P['muted'], 500, align='right', box=W - 2 * m)
    s.end()


# ------------------------------------------------------------------ data
random.seed(11)
DAYS = [f'{d} Sep' for d in range(2, 31)] + ['1 Oct']
weekday0 = 2  # 2 Sep 2026 is a Wednesday (Mon=0)
raw = []
for i in range(30):
    wd = (weekday0 + i) % 7
    base = 1250 + (650 if wd in (4, 5) else 300 if wd == 6 else 0)
    raw.append(base * random.uniform(0.78, 1.22))
scale = 48240 / sum(raw)
daily = [round(v * scale / 10) * 10 for v in raw]
daily[-1] += 48240 - sum(daily)
day_labels = [DAYS[i].replace(' Sep', '').replace(' Oct', ' Oct') if i % 5 == 0 or i == 29 else '' for i in range(30)]

PHONES = ['0712 345 678', '0798 765 432', '0701 112 233', '0722 334 455', '0733 445 566', '0744 556 677',
          '0755 667 788', '0766 778 899', '0711 223 344', '0790 887 766', '0725 109 283', '0708 554 120', '0746 330 918']
tx = [
    ('1 Oct', '9:12 am', 'Kitale Stage', PHONES[0], 'Phone', '24 hours', 'Till', 'Paid', 'SJK3XYZ123', '2 Oct, 9:12 am', 50),
    ('1 Oct', '8:47 am', 'Kitale Stage', PHONES[1], 'Phone', '1 hour', 'Till', 'Paid', 'SJK2LMN456', '1 Oct, 9:47 am', 20),
    ('1 Oct', '7:58 am', 'Eldoret Market', PHONES[8], 'TV', 'Weekly', 'PayBill', 'Paid', 'SJK1ABC902', '8 Oct, 7:58 am', 250),
    ('30 Sep', '9:05 pm', 'Eldoret Market', PHONES[2], 'Laptop', 'Weekly', 'PayBill', 'Paid', 'SJI9PQR789', '7 Oct, 9:05 pm', 250),
    ('30 Sep', '7:31 pm', 'Kitale Stage', PHONES[3], 'Phone', '3 hours', 'Till', 'Failed', '—', '—', 30),
    ('30 Sep', '6:02 pm', 'Eldoret Market', PHONES[4], 'Phone', '24 hours', 'Tuma', 'Paid', 'SJI7STU012', '1 Oct, 6:02 pm', 50),
    ('30 Sep', '4:44 pm', 'Kitale Stage', PHONES[5], 'Phone', '1 hour', 'Till', 'Paid', 'SJI6VWX345', '30 Sep, 5:44 pm', 20),
    ('30 Sep', '2:20 pm', 'Kitale Stage', PHONES[9], 'Tablet', '3 hours', 'Till', 'Refunded', 'SJI5KLM221', '—', 30),
    ('30 Sep', '12:15 pm', 'Kitale Stage', PHONES[6], 'Laptop', 'Monthly', 'Till', 'Paid', 'SJI3YZA678', '30 Oct, 12:15 pm', 800),
    ('30 Sep', '10:03 am', 'Eldoret Market', PHONES[10], 'Phone', '24 hours', 'Tuma', 'Paid', 'SJI2QWE118', '1 Oct, 10:03 am', 50),
    ('29 Sep', '8:58 pm', 'Eldoret Market', PHONES[7], 'Phone', '3 hours', 'PayBill', 'Pending', '—', '—', 30),
    ('29 Sep', '6:40 pm', 'Kitale Stage', PHONES[11], 'Phone', '1 hour', 'Voucher', 'Paid', 'VCH-81QZ', '29 Sep, 7:40 pm', 20),
    ('29 Sep', '5:12 pm', 'Kitale Stage', PHONES[12], 'TV', '24 hours', 'Till', 'Paid', 'SJH8RTY660', '30 Sep, 5:12 pm', 50),
]
tx_rows = []
for date, time, loc, phone, dev, pkg, method, status, code, exp, amt in tx:
    tx_rows.append(dict(date=date, time=time, loc=loc, phone=phone, dev=dev, pkg=pkg, method=method, status=status,
                        rcpt=code, exp=exp, amount=money(amt), _muted=('time',) if True else (),
                        _amt=amt if status == 'Paid' else 0))
tx_cols = [('date', 'Date', 6, 'left'), ('time', 'Time', 6.5, 'left'), ('loc', 'Hotspot', 11, 'left'), ('phone', 'Phone', 10, 'left'),
           ('dev', 'Device', 6.5, 'left'), ('pkg', 'Package', 7, 'left'), ('method', 'Paid to', 6.5, 'left'),
           ('status', 'Status', 8, 'left'), ('rcpt', 'M-Pesa code', 10, 'left'), ('exp', 'Wi-Fi ends', 11, 'left'), ('amount', 'Amount', 8, 'right')]

for old in os.listdir(OUT):
    if old.endswith('.svg'):
        os.remove(os.path.join(OUT, old))
files = []

# ------------------------------------------------------------------ receipts
contacts = [('Call or WhatsApp', '0712 345 678'), ('Email', 'hello@kitalecafe.co.ke'), ('Open', '6 am to 11 pm')]
files.append(receipt('01-customer-receipt.svg', 'Customer receipt', dict(
    brand=P['brand'], name='Kitale Cafe Wi-Fi', place='Kitale Stage, Kenyatta Street, Kitale', number='RCT-4K2Q9A', when='1 Oct 2026, 9:12 am',
    amount_label='You paid', amount='KES 50', state='paid', subtitle='24 hours of Wi-Fi',
    saved='Happy hour price. You saved KES 10 on the usual KES 60.',
    sections=[
        dict(title='Your Wi-Fi', items=[('row', 'Package', '24 hours, unlimited data'), ('row', 'Speed', 'Up to 10 Mbps down, 5 up'),
             ('row', 'Devices', '1 device'), ('row', 'Started', '1 Oct, 9:12 am'), ('row', 'Ends', '2 Oct, 9:12 am'),
             ('bar', 'Time left', '23 h 41 min', 0.987)]),
        dict(title='This device', items=[('row', 'Device', 'Phone, Galaxy A14'), ('code', 'MAC address', 'A4:30:7A:1C:5E:02'),
             ('code', 'IP address', '10.5.50.23'), ('row', 'Hotspot', 'Kitale Stage, router 2 of 3'), ('row', 'Network name', 'KitaleCafe-WiFi')]),
        dict(title='Payment', items=[('row', 'Paid with', 'M-Pesa prompt on 0712 345 678'), ('row', 'Paid to', 'Till 5123456, Kitale Cafe'),
             ('code', 'M-Pesa code', 'SJK3XYZ123'), ('row', 'Confirmed', '1 Oct, 9:12:41 am (in 6 s)'),
             ('row', '24 hours package', 'KES 60.00'), ('minus', 'Happy hour, 6 am to 10 am', '-KES 10.00'),
             ('total', 'Total paid', 'KES 50.00'),
             ('note', 'Prices include all charges. M-Pesa may charge its own fee on your side.')]),
    ],
    recovery=('K7MX4Q', 'Lost connection or changed phone? Open wififiti.net on this Wi-Fi and enter this code with your phone number.'),
    steps=('Reconnect in 3 steps', ['Join KitaleCafe-WiFi.', 'Open wififiti.net, or wait for the sign-in page.',
                                   'Tap "I already paid" and enter K7MX4Q.']),
    qr=('https://wififiti.net/r/RCT-4K2Q9A', 'Keep this receipt online', 'Scan to open it on any phone, check time left or buy more time.'),
    contacts=contacts, footer='Billed on Wi-Fi Fiti', printed='Printed 1 Oct 2026, 9:13 am')))

files.append(receipt('02-customer-receipt-tenant-color.svg', 'Customer receipt in a tenant color', dict(
    brand='#5B3FC4', name='Eldoret Net', place='Eldoret Market, Oloo Street, Eldoret', number='RCT-0Z81QX', when='1 Oct 2026, 11:40 am',
    amount_label='Waiting for you to approve', amount='KES 20', state='pending', subtitle='1 hour of Wi-Fi',
    sections=[
        dict(title='Your Wi-Fi', items=[('row', 'Package', '1 hour, unlimited data'), ('row', 'Speed', 'Up to 5 Mbps down, 2 up'),
             ('row', 'Devices', '1 device'), ('row', 'Starts', 'As soon as M-Pesa confirms'), ('bar', 'Prompt expires in', '0 min 48 s', 0.8)]),
        dict(title='This device', items=[('row', 'Device', 'Phone'), ('code', 'MAC address', '3C:28:6D:90:11:AF'),
             ('row', 'Hotspot', 'Eldoret Market')]),
        dict(title='Payment', items=[('row', 'Prompt sent to', '0798 765 432'), ('row', 'Paid to', 'PayBill 4098721, account EMKT'),
             ('row', 'M-Pesa code', 'Not received yet'), ('row', 'Attempt', '1 of 3'), ('total', 'To pay', 'KES 20.00'),
             ('note', 'Enter your M-Pesa PIN on your phone. No prompt? Tap Resend on the Wi-Fi page. You are not charged until you approve.')]),
    ],
    recovery=('P3QR7T', 'Save this now. It starts working once M-Pesa confirms, and gets you back online on any device.'),
    contacts=[('Call', '0798 765 432'), ('Email', 'help@eldoretnet.co.ke'), ('Open', '24 hours')],
    footer='Billed on Wi-Fi Fiti', printed='Printed 1 Oct 2026, 11:40 am')))

files.append(receipt('03-plan-receipt.svg', 'Wi-Fi Fiti plan receipt', dict(
    brand=P['brand'], name='Wi-Fi Fiti', place='Plan receipt for Kitale Cafe', number='WFP-7Q2K1M', when='1 Sep 2026, 1:00 pm',
    amount_label='Kitale Cafe paid', amount='KES 2,000', state='paid', subtitle='Growth plan, 1 month',
    sections=[
        dict(title='Plan', items=[('row', 'Plan', 'Growth, monthly'), ('row', 'Valid', '1 Sep to 1 Oct 2026'),
             ('row', 'Renews', '1 Oct 2026, KES 2,000'), ('row', 'Business ID', 'WF-20417')]),
        dict(title='Use this month', items=[('bar', 'Customers', '388 of 500', 388 / 500), ('bar', 'Routers', '3 of 3', 1.0),
             ('bar', 'Team members', '2 of 5', 0.4), ('bar', 'SMS receipts', '214 of 1,000', 0.214)]),
        dict(title='Charges', items=[('row', 'Growth plan', 'KES 1,500.00'), ('row', 'Extra router, 1', 'KES 500.00'),
             ('row', 'SMS bundle, 1,000', 'KES 250.00'), ('minus', 'Loyalty credit', '-KES 250.00'), ('total', 'Total paid', 'KES 2,000.00'),
             ('code', 'M-Pesa code', 'TST1234ABC'), ('row', 'Paid from', '0712 345 678, Morgan Mfo'),
             ('note', 'Not a statutory tax invoice. Ask for a KRA invoice from Settings, Billing.')]),
    ],
    qr=('https://wififiti.co.ke/billing/WFP-7Q2K1M', 'Billing history', 'Scan to see every plan payment and download invoices.'),
    contacts=[('Support', '0700 123 456'), ('Email', 'billing@wififiti.co.ke'), ('Hours', '7 am to 10 pm')],
    footer='wififiti.co.ke', printed='Printed 1 Oct 2026, 9:40 am')))

# ------------------------------------------------------------------ transactions PDF
W, H, m = 842, 595, 32
s = Svg(W, H, 'Kitale Cafe Transactions')
page(s, W, H, P['brand'], 'Kitale Cafe', 'Transactions', '2 Sep to 1 Oct 2026', 'Made 1 Oct 2026, 9:40 am by Morgan Mfo',
     ['Hotspots: all 2', 'Packages: all 6', 'Status: all', 'Paid to: all methods', '13 of 790 rows shown'], m)
figures(s, m, 114, W - 2 * m - 210, [('Collected', 'KES 48,240', '+12% vs before', True), ('Payments', '752', '+9%', True),
        ('Customers', '388', '+21 new', True), ('Failed', '18', '+4', False), ('Refunded', 'KES 90', '3 refunds', True)], P['brand'])
s.group('Daily sparkline')
sx, sy, sw_, sh = W - m - 190, 116, 190, 40
s.text(sx, sy + 8, 'Collected each day', 8.5, P['muted'], 500)
top = max(daily)
for i, v in enumerate(daily):
    bh = (sh - 14) * v / top
    s.rect(sx + i * (sw_ / 30), sy + sh + 6 - bh, sw_ / 30 * 0.62, bh, P['brand'] if v == top else blend(P['brand'], '#FFFFFF', 0.5), rx=1)
s.text(sx, sy + sh + 18, '2 Sep', 7, P['muted'], 400)
s.text(sx, sy + sh + 18, '1 Oct', 7, P['muted'], 400, align='right', box=sw_)
s.end()
paid_sum = sum(r['_amt'] for r in tx_rows)
y = table(s, m, 196, W - 2 * m, tx_cols, tx_rows, P['brand'], row_h=17, totals={'date': 'Shown', 'loc': '13 payments, 2 hotspots',
          'status': '10 paid', 'amount': money(paid_sum)})
s.group('Breakdown')
y += 18
bw = (W - 2 * m - 40) / 3
blocks = [('By hotspot', [('Kitale Stage', 'KES 31,020', 31020, ''), ('Eldoret Market', 'KES 17,220', 17220, '')]),
          ('Paid to', [('Till 5123456', 'KES 30,110', 30110, ''), ('PayBill 4098721', 'KES 11,940', 11940, ''), ('Tuma', 'KES 6,190', 6190, '')]),
          ('Device', [('Phones', '612', 612, ''), ('Laptops', '84', 84, ''), ('TVs', '56', 56, '')])]
for i, (name, rows) in enumerate(blocks):
    bx = m + i * (bw + 20)
    heading(s, bx, y, name, bw)
    share_rows(s, bx, y + 17, bw, rows, P['brand'], label_w=86, step=16)
s.end()
footer(s, W, H, m, ['Collected counts paid payments only. Failed and pending payments are listed but not counted. Times are East Africa Time.'])
files.append(s.save('04-transactions-pdf.svg'))

# ------------------------------------------------------------------ revenue PDF
W, H, m = 595, 842, 32
s = Svg(W, H, 'Kitale Cafe Revenue')
page(s, W, H, P['brand'], 'Kitale Cafe', 'Revenue', '2 Sep to 1 Oct 2026', 'Made 1 Oct 2026, 9:40 am',
     ['Hotspots: all 2', 'Packages: all 6', 'Paid only'], m)
figures(s, m, 114, W - 2 * m, [('Collected', 'KES 48,240', '+12%', True), ('Payments', '752', '+9%', True),
        ('Customers', '388', '+21 new', True), ('Average sale', 'KES 64', '+KES 3', True)], P['brand'])
heading(s, m, 200, 'Collected each day', W - 2 * m, f'Best day {DAYS[daily.index(max(daily))]}, {money(max(daily))}')
bar_chart(s, m, 216, W - 2 * m, 96, daily, day_labels, P['brand'])
col_w = (W - 2 * m - 24) / 2
pkgs = [('24 hours', 'KES 20,600', 20600, '412 sold, 43%'), ('Monthly', 'KES 11,200', 11200, '14 sold, 23%'),
        ('Weekly', 'KES 9,500', 9500, '38 sold, 20%'), ('3 hours', 'KES 3,540', 3540, '118 sold, 7%'), ('1 hour', 'KES 3,400', 3400, '170 sold, 7%')]
heading(s, m, 356, 'By package', col_w)
share_rows(s, m, 378, col_w, pkgs, P['brand'], label_w=62)
rx_ = m + col_w + 24
heading(s, rx_, 356, 'By hotspot', col_w)
yy = share_rows(s, rx_, 378, col_w, [('Kitale Stage', 'KES 31,020', 31020, '468 payments, 3 routers'),
                                      ('Eldoret Market', 'KES 17,220', 17220, '284 payments, 1 router')], P['brand'], label_w=82)
heading(s, rx_, yy + 8, 'Paid to', col_w)
share_rows(s, rx_, yy + 28, col_w, [('Till', 'KES 30,110', 30110, ''), ('PayBill', 'KES 11,940', 11940, ''), ('Tuma', 'KES 6,190', 6190, '')],
           P['brand'], label_w=82)
# Busiest hours heatmap.
s.group('Busiest hours')
hy = 534
heading(s, m, hy, 'Busiest hours', W - 2 * m - 150)
days7 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
gx, gy = m + 30, hy + 14
cell = (W - 2 * m - 30) / 24
ch = 13
for r, dname in enumerate(days7):
    s.text(m, gy + r * (ch + 2) + 9.5, dname, 7.5, P['muted'], 500)
    for c in range(24):
        evening = math.exp(-((c - 20) ** 2) / 8) + 0.6 * math.exp(-((c - 13) ** 2) / 6) + 0.45 * math.exp(-((c - 8) ** 2) / 3)
        night = 0.05 if c < 6 else 0
        v = (evening + night) * (1.35 if r in (4, 5) else 1.1 if r == 6 else 1) * random.uniform(0.8, 1.15)
        v = min(v / 1.6, 1)
        s.rect(gx + c * cell + 1, gy + r * (ch + 2), cell - 2, ch, blend('#EEF5F4', P['brand'], v), rx=2.5)
for c, lab in [(0, '12 am'), (6, '6 am'), (12, '12 pm'), (18, '6 pm'), (23, '11 pm')]:
    s.text(gx + c * cell, gy + 7 * (ch + 2) + 9, lab, 7, P['muted'], 400)
lx = W - m - 112
s.text(lx - 28, hy, 'Fewer', 7.5, P['muted'], 400)
for k in range(5):
    s.rect(lx + 2 + k * 16, hy - 7.5, 14, 8, blend('#EEF5F4', P['brand'], k / 4), rx=2)
s.text(lx + 86, hy, 'More', 7.5, P['muted'], 400, align='right', box=26)
s.end()
# Customers.
s.group('Customers')
cy0 = 694
heading(s, m, cy0, 'Customers', W - 2 * m, 'Repeat customers paid 71% of revenue')
ccx, ccy, rr = m + 34, cy0 + 50, 26
circ = 2 * math.pi * rr
s.add(f'<circle cx="{ccx}" cy="{ccy}" r="{rr}" fill="none" stroke="{P["brand_tint"]}" stroke-width="10"/>')
s.add(f'<circle cx="{ccx}" cy="{ccy}" r="{rr}" fill="none" stroke="{P["brand"]}" stroke-width="10" stroke-dasharray="{circ * 0.634:.1f} {circ:.1f}" transform="rotate(-90 {ccx} {ccy})"/>')
s.text(ccx - rr, ccy + 4, '63%', 11, P['ink'], 800, align='center', box=2 * rr)
s.text(m + 72, cy0 + 34, 'Came back', 8.5, P['muted'], 500)
s.text(m + 72, cy0 + 50, '246 customers', 11, P['ink'], 700)
s.text(m + 72, cy0 + 66, '142 new this month', 8.5, P['muted'], 400)
stats = [('Time online', '3 h 12 min', 'average a visit'), ('Top customer', '31 payments', '0712 *** 678'),
         ('Not collected', 'KES 840', '18 failed payments'), ('Data used', '1.9 TB', '5.0 GB a customer')]
sxw = (W - 2 * m - 190) / 4
for i, (a, b, c) in enumerate(stats):
    x0 = m + 190 + i * sxw
    vline(s, x0 - 10, cy0 + 24, cy0 + 72)
    s.text(x0, cy0 + 34, a, 8.5, P['muted'], 500)
    s.text(x0, cy0 + 50, b, 11, P['ink'], 700)
    s.text(x0, cy0 + 66, c, 8, P['muted'], 400)
s.end()
footer(s, W, H, m, ['Revenue is paid payments, before Wi-Fi Fiti fees. Compared with 3 Aug to 1 Sep 2026.'])
files.append(s.save('05-revenue-report-pdf.svg'))

# ------------------------------------------------------------------ payout statement
W, H, m = 842, 595, 32
s = Svg(W, H, 'Kitale Cafe Payout statement')
page(s, W, H, P['brand'], 'Kitale Cafe', 'Payout statement', '2 Sep to 1 Oct 2026', 'Made 1 Oct 2026, 9:40 am',
     ['Collected by Wi-Fi Fiti for you', 'Fee: 5% of each payment', 'Statement WF-ST-0926'], m)
s.group('Balance')
eq = [('Opening balance', 1000.00, None), ('Collected', 9670.00, '+'), ('Fees', 483.50, '−'), ('Paid out and refunds', 5030.00, '−'),
      ('On hold', 2000.00, '−'), ('Available now', 3156.50, '=')]
ex = m
ew = (W - 2 * m) / len(eq)
for i, (label, v, op) in enumerate(eq):
    last = i == len(eq) - 1
    bx = ex + i * ew
    if last:
        s.rect(bx + 10, 110, ew - 10, 56, P['brand'], rx=10)
    if op:
        s.add(f'<circle cx="{bx:.1f}" cy="138" r="9" fill="{P["paper"]}"/>')
        s.text(bx - 9, 141.8, op, 11, P['ink'], 700, align='center', box=18)
    tx0 = bx + (22 if i else 0)
    s.text(tx0, 128, label, 8.5, P['white'] if last else P['muted'], 500)
    s.text(tx0, 152, money(v, True), 14 if last else 13, P['white'] if last else P['ink'], 800 if last else 700)
s.end()
events = [
    ('2 Sep', 'Opening balance', '', 'Opening', 0, 0, 0),
    ('7 Sep', 'Sales collected, 2 to 7 Sep, 141 payments', 'WF-C-0907', 'Collected', 2120.00, 0, 106.00),
    ('8 Sep', 'Payout to Morgan Mfo, M-Pesa 0712 *** 678', 'QWA912KLM', 'Paid', 0, 2000.00, 0),
    ('14 Sep', 'Sales collected, 8 to 14 Sep, 168 payments', 'WF-C-0914', 'Collected', 2410.00, 0, 120.50),
    ('15 Sep', 'Refund to 0790 887 766, failed connection', 'RF-0915-2', 'Refunded', 0, 30.00, 0),
    ('21 Sep', 'Sales collected, 15 to 21 Sep, 177 payments', 'WF-C-0921', 'Collected', 2530.00, 0, 126.50),
    ('22 Sep', 'Payout to Kitale Cafe Ltd, KCB bank ending 6789', 'FT26265XQ', 'Paid', 0, 3000.00, 0),
    ('28 Sep', 'Sales collected, 22 to 28 Sep, 171 payments', 'WF-C-0928', 'Collected', 2280.00, 0, 114.00),
    ('29 Sep', 'Adjustment: refund returned by customer', 'RF-0915-2', 'Collected', 30.00, 0, 0),
    ('1 Oct', 'Sales collected, 29 Sep to 1 Oct, 95 payments', 'WF-C-1001', 'Collected', 300.00, 0, 16.50),
    ('1 Oct', 'Payout to Kitale Cafe Ltd, KCB bank ending 6789', 'Request 18', 'Waiting for review', 0, 2000.00, 0),
]
bal = 1000.00
pay_rows = []
for date, desc, ref, status, inn, out, fee in events:
    bal = bal + inn - fee - out
    pay_rows.append(dict(date=date, desc=desc, ref=ref or '—', status=status, fee=money(fee, True) if fee else '',
                         min=money(inn, True) if inn else '', mout=money(out, True) if out else '', bal=money(bal, True),
                         _muted=('ref',), _strong=('bal',)))
pay_rows[0]['bal'] = money(1000, True)
pay_cols = [('date', 'Date', 6, 'left'), ('desc', 'What happened', 32, 'left'), ('ref', 'Reference', 10, 'left'),
            ('status', 'Status', 13, 'left'), ('min', 'In', 10, 'right'), ('fee', 'Fee', 8.5, 'right'),
            ('mout', 'Out', 10, 'right'), ('bal', 'Balance', 11, 'right')]
y = table(s, m, 194, W - 2 * m, pay_cols, pay_rows, P['brand'], row_h=19,
          totals={'date': 'Totals', 'min': money(9670, True), 'fee': money(483.5, True), 'mout': money(7030, True), 'bal': money(3156.5, True), '_brand': 'bal'})
s.group('Accounts')
y += 22
aw = (W - 2 * m - 20) / 2
heading(s, m, y, 'Where payouts go', aw)
acc = [('M-Pesa 0712 *** 678, Morgan Mfo', 'Default for Kitale Stage', 'Default'),
       ('KCB bank ending 6789, Kitale Cafe Ltd', 'Default for Eldoret Market', '')]
for i, (a, b, tag) in enumerate(acc):
    yy = y + 20 + i * 26
    s.text(m, yy, a, 9, P['ink'], 600)
    s.text(m, yy + 11, b, 7.5, P['muted'], 400)
    if tag:
        chip(s, m + width(a, 9, 600) + 8, yy - 9, tag, P['brand_tint'], P['brand'], 7.5, 600)
bx = m + aw + 20
heading(s, bx, y, 'Good to know', aw)
for i, line in enumerate(['Payouts over KES 1,000 are reviewed within 1 working day.',
                          'On hold is money in payout requests not yet sent.',
                          'Next automatic payout: Mon 5 Oct, if the balance is over KES 500.']):
    s.add(f'<circle cx="{bx + 3}" cy="{y + 17 + i * 15}" r="2" fill="{P["brand"]}"/>')
    s.text(bx + 10, y + 20 + i * 15, line, 8.5, P['ink'], 400)
s.end()
footer(s, W, H, m, [])
files.append(s.save('06-payout-statement-pdf.svg'))

# ------------------------------------------------------------------ excel
def excel_v3(filename, brand):
    cols = [('date', 'Date', 72, 'left'), ('time', 'Time', 64, 'left'), ('loc', 'Hotspot', 104, 'left'), ('phone', 'Phone', 96, 'left'),
            ('dev', 'Device', 62, 'left'), ('pkg', 'Package', 70, 'left'), ('method', 'Paid to', 64, 'left'),
            ('status', 'Status', 84, 'left'), ('rcpt', 'M-Pesa code', 96, 'left'), ('amount', 'Amount', 112, 'right')]
    heads = 38
    col_w = [c[2] for c in cols]
    n_rows = 8 + len(tx_rows) + 3
    hs = {1: 8, 2: 44, 3: 20, 4: 10, 5: 18, 6: 30, 7: 12, 8: 26}
    hs = [hs.get(r, 22) for r in range(1, n_rows + 1)]
    W = heads + sum(col_w)
    top = 30 + 22
    tabs_h = 30
    H = top + sum(hs) + tabs_h
    s = Svg(W, H, 'Kitale Cafe Transactions (Excel)')
    s.rect(0, 0, W, H, P['white'])
    xs = [heads]
    for w in col_w:
        xs.append(xs[-1] + w)
    ys = [top]
    for h in hs:
        ys.append(ys[-1] + h)
    total_r = 8 + len(tx_rows) + 1  # 0-based index of the totals row
    s.group('Spreadsheet chrome')
    s.rect(0, 0, W, 30, '#F3F4F6')
    s.rect(6, 6, 46, 18, P['white'], rx=3, stroke='#D1D5DB', sw=0.6)
    s.text(6, 19, f'J{total_r + 1}', 9.5, '#374151', 500, align='center', box=46)
    s.text(62, 19.5, 'fx', 10, '#6B7280', 500)
    s.text(84, 19.5, f'=SUBTOTAL(9,J9:J{8 + len(tx_rows)})', 10, '#374151', 400)
    s.rect(0, 30, W, 22, '#F3F4F6')
    for i, w in enumerate(col_w):
        s.text(xs[i], 45, chr(65 + i), 9.5, '#6B7280', 500, align='center', box=w)
    for r in range(n_rows):
        s.rect(0, ys[r], heads, hs[r], '#F3F4F6')
        s.text(0, ys[r] + hs[r] / 2 + 3.3, str(r + 1), 9, '#6B7280', 500, align='center', box=heads)
    for x in xs:
        vline(s, x, 30, ys[-1], '#E5E7EB', 0.6)
    for y in ys:
        hline(s, 0, W, y, '#EEF0F2', 0.6)
    s.end()
    s.rect(heads, ys[0], sum(col_w), hs[0], brand, name='Brand edge (row 1)')
    s.group('Title (rows 2-3)')
    s.rect(heads, ys[1], sum(col_w), hs[1] + hs[2], P['white'])
    s.mark(xs[0] + 10, ys[1] + 12, 20, brand, name='Logo image')
    s.text(xs[0] + 40, ys[1] + 31, 'Transactions', 22, P['ink'], 800)
    s.text(xs[0] + 40 + width('Transactions', 22, 800) + 12, ys[1] + 31, 'Kitale Cafe, business ID WF-20417', 11, P['muted'], 500)
    s.text(xs[0] + 40, ys[2] + 14, '2 Sep to 1 Oct 2026, made 1 Oct 2026, 9:40 am by Morgan Mfo. Filters: all hotspots, all packages.', 9.5, P['muted'], 400)
    s.end()
    s.group('Figures (rows 5-6)')
    figs = [('Collected', 'KES 48,240', '+12%', True), ('Payments', '752', '+9%', True), ('Customers', '388', '+21 new', True),
            ('Failed', '18', '+4', False), ('Average sale', 'KES 64', '+KES 3', True)]
    for i, (label, value, ch_, good) in enumerate(figs):
        x0 = xs[i * 2]
        s.text(x0 + 10, ys[4] + 13, label, 9, P['muted'], 500)
        vw = s.text(x0 + 10, ys[5] + 22, value, 17 if i == 0 else 14, brand if i == 0 else P['ink'], 800 if i == 0 else 700)
        s.text(x0 + 16 + vw, ys[5] + 21, ch_, 8.5, P['paid'] if good else P['failed'], 600)
    s.end()
    s.group('Header (row 8) with filters')
    s.rect(heads, ys[7], sum(col_w), hs[7], P['brand_tint'])
    hline(s, heads, W, ys[8], brand, 1.5)
    for i, (key, label, _, align) in enumerate(cols):
        box = col_w[i] - 34
        s.text(xs[i] + 8, ys[7] + 17, label, 9.5, P['ink'], 700, align=align, box=box)
        fx_ = xs[i + 1] - 20
        s.rect(fx_, ys[7] + 5, 15, 15, P['white'], rx=2, stroke='#C9D6D4', sw=0.6)
        s.add(f'<path d="M{fx_ + 4.5} {ys[7] + 10.5}h6l-3 3.5z" fill="{P["muted"]}"/>')
    s.end()
    s.group('Rows (row 9 on)')
    top_amt = max(int(r['amount'].replace('KES ', '').replace(',', '')) for r in tx_rows)
    for j, row in enumerate(tx_rows):
        r = 8 + j
        if j % 2:
            s.rect(heads, ys[r], sum(col_w), hs[r], '#F8FBFA')
        for i, (key, label, _, align) in enumerate(cols):
            value = str(row.get(key, ''))
            if key == 'status' and value in STATUS:
                color, word = STATUS[value]
                s.add(f'<circle cx="{xs[i] + 12:.1f}" cy="{ys[r] + 11:.1f}" r="3" fill="{color}"/>')
                s.text(xs[i] + 20, ys[r] + 14.5, word, 9.5, P['ink'], 500)
            elif key == 'amount':
                amt = int(value.replace('KES ', '').replace(',', ''))
                bw = (col_w[i] - 8) * amt / top_amt
                s.rect(xs[i] + 4, ys[r] + 4, bw, hs[r] - 8, blend(brand, '#FFFFFF', 0.8), rx=2)
                s.text(xs[i] + 8, ys[r] + 14.5, value, 9.5, P['ink'], 600, align='right', box=col_w[i] - 16)
            else:
                tone = P['muted'] if key == 'time' or value == '—' else P['ink']
                s.text(xs[i] + 8, ys[r] + 14.5, value, 9.5, tone, 400, align=align, box=col_w[i] - 16)
    s.end()
    s.group('Freeze line')
    hline(s, 0, W, ys[8], '#9CA3AF', 1.2)
    s.end()
    s.group('Totals')
    tr = total_r
    s.rect(heads, ys[tr], sum(col_w), hs[tr], P['paper'])
    hline(s, heads, W, ys[tr], P['ink'], 1.2)
    s.text(xs[0] + 8, ys[tr] + 14.5, 'Total, rows shown', 9.5, P['ink'], 700)
    s.text(xs[7] + 8, ys[tr] + 14.5, '10 paid', 9.5, P['ink'], 600)
    s.text(xs[9] + 8, ys[tr] + 14.5, money(paid_sum), 9.5, brand, 800, align='right', box=col_w[9] - 16)
    s.rect(xs[9], ys[tr], col_w[9], hs[tr], 'none', stroke=brand, sw=2)
    s.rect(xs[10] - 3, ys[tr + 1] - 3, 6, 6, brand)
    s.end()
    s.group('Sheet tabs')
    ty = ys[-1]
    s.rect(0, ty, W, tabs_h, '#F3F4F6')
    tx_ = 12
    for k, name in enumerate(['Transactions', 'By hotspot', 'By package', 'By day', 'Busiest hours', 'Summary']):
        tw = width(name, 9.5, 600 if k == 0 else 400) + 24
        if k == 0:
            s.rect(tx_, ty, tw, tabs_h - 6, P['white'])
            hline(s, tx_, tx_ + tw, ty + tabs_h - 6, brand, 2)
        s.text(tx_ + 12, ty + 16, name, 9.5, brand if k == 0 else '#4B5563', 600 if k == 0 else 400)
        tx_ += tw + 4
    s.text(0, ty + 16, f'Sum {money(paid_sum)}   Count {len(tx_rows)}', 9, '#4B5563', 400, align='right', box=W - 12)
    s.end()
    return s.save(filename)


files.append(excel_v3('07-transactions-excel.svg', P['brand']))
print('\n'.join(files))

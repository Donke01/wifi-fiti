"""Wi-Fi Fiti documents, redesign (v2): signal arcs, ticket stub, Bricolage Grotesque.

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


# ------------------------------------------------------------------ receipt
def receipt(filename, title, brand_name, brand, amount, state, subtitle, rows, code_label, code, note, footer):
    W, H = 320, 520
    s = Svg(W, H, title)
    head_h = 176
    s.group('Ticket')
    paper_at = len(s.parts)
    s.rect(0, 0, W, H, P['white'], rx=18, name='Paper')
    # Brand block with the signal arcs radiating from its lower right corner.
    s.group('Brand block')
    s.add(f'<path id="Block" d="M0 18A18 18 0 0 1 18 0H{W - 18}A18 18 0 0 1 {W} 18V{head_h}H0Z" fill="{brand}"/>')
    s.arcs(W - 18, head_h + 10, [34, 62, 90, 118, 146], P['white'], 0.13, 9, (0, 0, W, head_h, 0))
    s.mark(22, 22, 18, P['white'])
    s.text(48, 36, brand_name, 13, P['white'], 600, name='Business name')
    s.text(22, 108, amount, 46, P['white'], 800, name='Amount')
    # Status chip + what was bought.
    color, label = STATUS[state]
    cw = width(label, 10, 600) + 30
    s.group('Status chip')
    s.rect(22, 126, cw, 24, P['mint'] if state == 'paid' else '#FFE7A8' if state == 'pending' else '#FFD2CC', rx=12)
    s.add(f'<circle cx="35" cy="138" r="3.5" fill="{color}"/>')
    s.text(44, 141.6, label, 10, P['ink'], 600)
    s.end()
    s.text(22 + cw + 10, 141.6, subtitle, 10, P['white'], 500, name='What was bought')
    s.end()
    # Perforation: notches on both edges and a dashed tear line.
    s.group('Perforation')
    s.add(f'<circle cx="0" cy="{head_h + 18}" r="9" fill="{P["paper"]}"/>')
    s.add(f'<circle cx="{W}" cy="{head_h + 18}" r="9" fill="{P["paper"]}"/>')
    s.add(f'<line x1="16" y1="{head_h + 18}" x2="{W - 16}" y2="{head_h + 18}" stroke="{P["line"]}" stroke-width="1.4" stroke-dasharray="4 4" stroke-linecap="round"/>')
    s.end()
    # Details: label left, value right.
    y = head_h + 46
    s.group('Details')
    for label, value in rows:
        s.text(22, y, label, 10, P['muted'], 400)
        s.text(22, y, value, 10, P['ink'], 600, align='right', box=W - 44)
        y += 24
    s.end()
    # M-Pesa code panel.
    y += 2
    s.group('Code panel')
    s.rect(22, y, W - 44, 58, P['paper'], rx=12)
    s.text(36, y + 22, code_label, 9.5, P['muted'], 500)
    if state == 'paid':
        s.text(36, y + 45, code, 18, P['ink'], 700, spacing=1.2)
    else:
        s.text(36, y + 43, code, 13, P['muted'], 600)
    s.end()
    y += 58 + 24
    s.group('Footer')
    s.text(22, y, note, 9, P['muted'], 400, name='Note')
    y += 26
    s.add(f'<line x1="22" y1="{y - 12}" x2="{W - 22}" y2="{y - 12}" stroke="{P["line"]}" stroke-width="1"/>')
    s.mark(22, y - 4, 12, brand, name='Footer mark')
    s.text(39, y + 5.5, footer, 8.5, P['muted'], 500)
    s.end()
    s.end()
    s.h = int(y + 24)
    s.parts[paper_at] = f'<rect id="Paper" x="0" y="0" width="{W}" height="{s.h}" rx="18" fill="{P["white"]}"/>'
    return s.save(filename)


# ------------------------------------------------------------------ reports
def report(filename, title, brand_name, brand, doc_title, period, generated, figures, columns, rows, landscape, share_key=None, extra=None):
    W, H = (842, 595) if landscape else (595, 842)
    s = Svg(W, H, f'{brand_name} {doc_title}')
    s.rect(0, 0, W, H, P['white'], name='Page')
    s.rect(0, 0, W, 6, brand, name='Brand edge')
    # Signal arcs from the top-right corner, faint.
    s.arcs(W + 10, -40, [70, 110, 150, 190], brand, 0.10, 14, (0, 6, W, 100, 0))
    m = 40
    s.group('Heading')
    s.mark(m, 34, 16, brand)
    s.text(m + 22, 46, brand_name, 11, P['ink'], 600, name='Business')
    s.text(m, 88, doc_title, 32, P['ink'], 800, name='Title')
    s.text(m, 46, period, 11, P['ink'], 600, align='right', box=W - 2 * m, name='Period')
    s.text(m, 62, generated, 9, P['muted'], 400, align='right', box=W - 2 * m, name='Generated')
    s.end()
    # Figures strip: the first figure leads, the rest follow, split by hairlines.
    y = 116
    s.group('Figures')
    x = m
    for i, (label, value) in enumerate(figures):
        big = 26 if i == 0 else 18
        vw = width(value, big, 800 if i == 0 else 700)
        lw = width(label, 9.5, 500)
        colw = max(vw, lw) + 34
        s.text(x, y + 12, label, 9.5, P['muted'], 500)
        s.text(x, y + (40 if i == 0 else 36), value, big, brand if i == 0 else P['ink'], 800 if i == 0 else 700)
        x += colw
        if i < len(figures) - 1:
            s.add(f'<line x1="{x - 17:.1f}" y1="{y}" x2="{x - 17:.1f}" y2="{y + 44}" stroke="{P["line"]}" stroke-width="1"/>')
    s.end()
    def table(y, columns, rows, share_key, heading=None):
        if heading:
            s.text(m, y, heading, 14, P['ink'], 700, name=heading)
            y += 30
        pw = W - 2 * m
        total = sum(c[2] for c in columns)
        widths = [c[2] / total * pw for c in columns]
        s.group('Table header')
        x = m
        for (key, label, _, align), w in zip(columns, widths):
            s.text(x, y, label, 9, P['muted'], 600, align=align, box=w - 10)
            x += w
        s.add(f'<line x1="{m}" y1="{y + 9}" x2="{W - m}" y2="{y + 9}" stroke="{P["ink"]}" stroke-width="1.4"/>')
        s.end()
        y += 9
        max_share = max((r.get('_share', 0) for r in rows), default=0) or 1
        s.group('Table rows')
        for row in rows:
            y += 26
            x = m
            for (key, label, _, align), w in zip(columns, widths):
                value = str(row.get(key, ''))
                if key == 'status' and value in STATUS:
                    color, word = STATUS[value]
                    s.add(f'<circle cx="{x + 3.5:.1f}" cy="{y - 3.6:.1f}" r="3.2" fill="{color}"/>')
                    s.text(x + 12, y, word, 10, P['ink'], 500)
                elif key == share_key:
                    share = row.get('_share', 0) / max_share
                    track = w - 96
                    s.rect(x + 8, y - 9, track, 8, P['brand_tint'], rx=4)
                    s.rect(x + 8, y - 9, max(track * share, 6), 8, brand, rx=4)
                    s.text(x, y, value, 10, P['ink'], 600, align='right', box=w - 10)
                else:
                    weight = 600 if align == 'right' else 400
                    color = P['muted'] if value in ('—', '') else P['ink']
                    s.text(x, y, value, 10, color, weight, align=align, box=w - 10)
                x += w
            s.add(f'<line x1="{m}" y1="{y + 10}" x2="{W - m}" y2="{y + 10}" stroke="{P["line"]}" stroke-width="0.8"/>')
        s.end()
        return y + 10

    y = table(192, columns, rows, share_key)
    for heading, cols2, rows2, key2 in (extra or []):
        y = table(y + 48, cols2, rows2, key2, heading)
    s.group('Footer')
    s.add(f'<line x1="{m}" y1="{H - 40}" x2="{W - m}" y2="{H - 40}" stroke="{P["line"]}" stroke-width="0.8"/>')
    s.mark(m, H - 32, 11, P['muted'], name='Footer mark')
    s.text(m + 16, H - 23, 'Billed on Wi-Fi Fiti, M-Pesa hotspot billing', 8.5, P['muted'], 500)
    s.text(m, H - 23, 'Page 1 of 1', 8.5, P['muted'], 500, align='right', box=W - 2 * m)
    s.end()
    return s.save(filename)


# ------------------------------------------------------------------ excel
def excel(filename, brand_name, brand, doc_title, period, figures, columns, rows):
    col_w = [130 if c[2] >= 16 else 100 for c in columns]
    heads = 38
    heights = {1: 8, 2: 44, 3: 22, 4: 12, 5: 18, 6: 30, 7: 14, 8: 26}
    n_rows = 8 + len(rows) + 2
    hs = [heights.get(r, 22) for r in range(1, n_rows + 1)]
    W = heads + sum(col_w)
    top = 30 + 22
    H = top + sum(hs)
    s = Svg(W, H, f'{brand_name} {doc_title} (Excel)')
    s.rect(0, 0, W, H, P['white'])
    s.group('Spreadsheet chrome')
    s.rect(0, 0, W, 30, '#F3F4F6')
    s.text(12, 19.5, 'fx', 10.5, '#6B7280', 500)
    s.text(40, 19.5, doc_title, 10.5, '#374151', 400)
    s.rect(0, 30, W, 22, '#F3F4F6')
    xs = [heads]
    for w in col_w:
        xs.append(xs[-1] + w)
    for i, w in enumerate(col_w):
        s.text(xs[i], 45, chr(65 + i), 9.5, '#6B7280', 500, align='center', box=w)
    ys = [top]
    for h in hs:
        ys.append(ys[-1] + h)
    for r in range(n_rows):
        s.rect(0, ys[r], heads, hs[r], '#F3F4F6')
        s.text(0, ys[r] + hs[r] / 2 + 3.3, str(r + 1), 9, '#6B7280', 500, align='center', box=heads)
    for x in xs:
        s.add(f'<line x1="{x}" y1="30" x2="{x}" y2="{H}" stroke="#E5E7EB" stroke-width="0.6"/>')
    for y in ys:
        s.add(f'<line x1="0" y1="{y}" x2="{W}" y2="{y}" stroke="#EEF0F2" stroke-width="0.6"/>')
    s.end()
    s.group('Brand edge (row 1)')
    s.rect(heads, ys[0], sum(col_w), hs[0], brand)
    s.end()
    s.group('Title (rows 2-3)')
    s.rect(heads, ys[1], sum(col_w), hs[1] + hs[2], P['white'])
    s.mark(xs[0] + 10, ys[1] + 12, 20, brand, name='Logo image')
    s.text(xs[0] + 40, ys[1] + 31, f'{doc_title}', 22, P['ink'], 800)
    s.text(xs[0] + 40 + width(doc_title, 22, 800) + 12, ys[1] + 31, brand_name, 12, P['muted'], 500)
    s.text(xs[0] + 40, ys[2] + 15, period, 10, P['muted'], 400)
    s.end()
    s.group('Figures (rows 5-6)')
    for i, (label, value) in enumerate(figures):
        x0 = xs[i * 2] if i * 2 < len(xs) else xs[-1]
        s.text(x0 + 10, ys[4] + 13, label, 9, P['muted'], 500)
        s.text(x0 + 10, ys[5] + 22, value, 18 if i == 0 else 15, brand if i == 0 else P['ink'], 800 if i == 0 else 700)
    s.end()
    s.group('Header (row 8)')
    s.rect(heads, ys[7], sum(col_w), hs[7], P['brand_tint'])
    s.add(f'<line x1="{heads}" y1="{ys[8]}" x2="{W}" y2="{ys[8]}" stroke="{brand}" stroke-width="1.5"/>')
    for i, (key, label, _, align) in enumerate(columns):
        s.text(xs[i] + 8, ys[7] + 17, label, 9.5, P['ink'], 700, align=align, box=col_w[i] - 16)
    s.end()
    s.group('Rows (row 9 on)')
    for j, row in enumerate(rows):
        r = 8 + j
        for i, (key, label, _, align) in enumerate(columns):
            value = str(row.get(key, ''))
            if key == 'status' and value in STATUS:
                color, word = STATUS[value]
                s.add(f'<circle cx="{xs[i] + 12:.1f}" cy="{ys[r] + 11:.1f}" r="3" fill="{color}"/>')
                s.text(xs[i] + 20, ys[r] + 14.5, word, 9.5, P['ink'], 500)
            else:
                s.text(xs[i] + 8, ys[r] + 14.5, value, 9.5, P['ink'], 600 if align == 'right' else 400, align=align, box=col_w[i] - 16)
        s.add(f'<line x1="{heads}" y1="{ys[r + 1]}" x2="{W}" y2="{ys[r + 1]}" stroke="{P["line"]}" stroke-width="0.8"/>')
    s.end()
    return s.save(filename)


for old in os.listdir(OUT):
    if old.endswith('.svg'):
        os.remove(os.path.join(OUT, old))

files = []
files.append(receipt('01-customer-receipt.svg', 'Customer receipt', 'Kitale Cafe Wi-Fi', P['brand'], 'KES 50', 'paid', '24 hours of Wi-Fi',
    [('Paid on', '1 Oct 2026, 9:12 am'), ('Phone', '0712 345 678'), ('Hotspot', 'Kitale Stage'), ('Receipt', 'RCT-4K2Q9A')],
    'M-Pesa code', 'SJK3XYZ123', 'Questions? Call 0712 345 678', 'Billed on Wi-Fi Fiti'))
files.append(receipt('02-customer-receipt-tenant-color.svg', 'Customer receipt in a tenant color', 'Eldoret Net', '#5B3FC4', 'KES 20', 'pending', '1 hour of Wi-Fi',
    [('Started', '1 Oct 2026, 11:40 am'), ('Phone', '0798 765 432'), ('Hotspot', 'Eldoret Market'), ('Receipt', 'RCT-0Z81QX')],
    'M-Pesa code', 'Not received yet', 'This updates when M-Pesa confirms', 'Billed on Wi-Fi Fiti'))
files.append(receipt('03-plan-receipt.svg', 'Wi-Fi Fiti plan receipt', 'Wi-Fi Fiti', P['brand'], 'KES 1,500', 'paid', 'Hotspot users plan',
    [('Business', 'Kitale Cafe'), ('Paid on', '1 Sep 2026, 1:00 pm'), ('Valid until', '1 Oct 2026, 1:00 pm'), ('Reference', 'WFP-7Q2K1M')],
    'M-Pesa code', 'TST1234ABC', 'Not a statutory tax invoice', 'wififiti.co.ke'))

tx_rows = [
    dict(date='1 Oct, 9:12 am', loc='Kitale Stage', phone='0712 345 678', pkg='24 hours', amount='KES 50', status='Paid', rcpt='SJK3XYZ123'),
    dict(date='1 Oct, 8:47 am', loc='Kitale Stage', phone='0798 765 432', pkg='1 hour', amount='KES 20', status='Paid', rcpt='SJK2LMN456'),
    dict(date='30 Sep, 9:05 pm', loc='Eldoret Market', phone='0701 112 233', pkg='Weekly', amount='KES 250', status='Paid', rcpt='SJI9PQR789'),
    dict(date='30 Sep, 7:31 pm', loc='Kitale Stage', phone='0722 334 455', pkg='3 hours', amount='KES 30', status='Failed', rcpt='—'),
    dict(date='30 Sep, 6:02 pm', loc='Eldoret Market', phone='0733 445 566', pkg='24 hours', amount='KES 50', status='Paid', rcpt='SJI7STU012'),
    dict(date='30 Sep, 4:44 pm', loc='Kitale Stage', phone='0744 556 677', pkg='1 hour', amount='KES 20', status='Paid', rcpt='SJI6VWX345'),
    dict(date='30 Sep, 12:15 pm', loc='Kitale Stage', phone='0755 667 788', pkg='Monthly', amount='KES 800', status='Paid', rcpt='SJI3YZA678'),
    dict(date='29 Sep, 8:58 pm', loc='Eldoret Market', phone='0766 778 899', pkg='3 hours', amount='KES 30', status='Pending', rcpt='—'),
]
tx_cols = [('date', 'Date', 16, 'left'), ('loc', 'Hotspot', 17, 'left'), ('phone', 'Phone', 15, 'left'), ('pkg', 'Package', 12, 'left'),
           ('status', 'Status', 12, 'left'), ('rcpt', 'M-Pesa code', 15, 'left'), ('amount', 'Amount', 11, 'right')]
files.append(report('04-transactions-pdf.svg', 'Transactions PDF', 'Kitale Cafe', P['brand'], 'Transactions', 'Last 30 days', 'Made 1 Oct 2026, 9:40 am',
    [('Collected', 'KES 1,250'), ('Payments', '8'), ('Failed', '1')], tx_cols, tx_rows, landscape=True))

rev = [('Monthly', 14, 11200), ('Weekly', 38, 9500), ('24 hours', 412, 20600), ('3 hours', 118, 3540), ('1 hour', 170, 3400)]
rev_rows = [dict(pkg=n, count=f'{c:,}', amount=f'KES {a:,}', _share=a) for n, c, a in sorted(rev, key=lambda r: -r[2])]
files.append(report('05-revenue-report-pdf.svg', 'Revenue report PDF', 'Kitale Cafe', P['brand'], 'Revenue', '1 Sep to 1 Oct 2026', 'Made 1 Oct 2026, 9:40 am',
    [('Collected', 'KES 48,240'), ('Payments', '752'), ('Customers', '388'), ('Average sale', 'KES 64')],
    [('pkg', 'Package', 26, 'left'), ('count', 'Sold', 12, 'right'), ('amount', 'Revenue', 40, 'right')], rev_rows, landscape=False, share_key='amount',
    extra=[('By hotspot', [('loc', 'Hotspot', 26, 'left'), ('count', 'Payments', 12, 'right'), ('amount', 'Revenue', 40, 'right')],
            [dict(loc='Kitale Stage', count='468', amount='KES 31,020', _share=31020), dict(loc='Eldoret Market', count='284', amount='KES 17,220', _share=17220)], 'amount'),
           ('By day of week', [('day', 'Day', 26, 'left'), ('count', 'Payments', 12, 'right'), ('amount', 'Revenue', 40, 'right')],
            [dict(day=d, count=str(c), amount=f'KES {a:,}', _share=a) for d, c, a in [('Monday', 82, 5210), ('Tuesday', 79, 4980), ('Wednesday', 84, 5390), ('Thursday', 88, 6020), ('Friday', 142, 9120), ('Saturday', 156, 9880), ('Sunday', 121, 7640)]], 'amount')]))

pay_rows = [
    dict(date='28 Sep', desc='Sales collected for you, 64 payments', fee='KES 160.00', min='KES 3,040.00', mout='', status='Collected', ref=''),
    dict(date='29 Sep', desc='Sales collected for you, 71 payments', fee='KES 182.50', min='KES 3,467.50', mout='', status='Collected', ref=''),
    dict(date='29 Sep', desc='Payout to Morgan Mfo, M-Pesa ending 5678', fee='', min='', mout='KES 5,000.00', status='Paid', ref='QWE123RTY'),
    dict(date='30 Sep', desc='Sales collected for you, 58 payments', fee='KES 141.00', min='KES 2,679.00', mout='', status='Collected', ref=''),
    dict(date='1 Oct', desc='Payout to Kitale Cafe Ltd, bank ending 6789', fee='', min='', mout='KES 2,000.00', status='Waiting for review', ref=''),
]
files.append(report('06-payout-statement-pdf.svg', 'Payout statement PDF', 'Kitale Cafe', P['brand'], 'Payout statement', 'Last 30 days', 'Made 1 Oct 2026, 9:40 am',
    [('Available to request', 'KES 2,186.50'), ('Collected for you', 'KES 9,186.50'), ('Paid out', 'KES 5,000.00'), ('Waiting for review', 'KES 2,000.00')],
    [('date', 'Date', 8, 'left'), ('desc', 'What happened', 36, 'left'), ('status', 'Status', 15, 'left'), ('ref', 'Reference', 12, 'left'),
     ('fee', 'Fee', 10, 'right'), ('min', 'In', 12, 'right'), ('mout', 'Out', 12, 'right')], pay_rows, landscape=True))

files.append(excel('07-transactions-excel.svg', 'Kitale Cafe', P['brand'], 'Transactions', 'Last 30 days, made 1 Oct 2026',
    [('Collected', 'KES 1,250'), ('Payments', '8'), ('Failed', '1')], tx_cols, tx_rows))
print('\n'.join(files))

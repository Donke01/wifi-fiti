"""Draw the Wi-Fi Fiti document designs as SVG files for Figma.

Every measurement mirrors src/lib/documents/{receipt,report}.js so the
designs match what the server produces. Text is measured with Liberation
Sans (same widths as Arimo / Helvetica) and placed with start anchors, so
Figma imports it in exactly the right place as editable text.
"""
import os
from xml.sax.saxutils import escape
from PIL import ImageFont

OUT = '/home/claude/wifi-fiti/design/documents'
os.makedirs(OUT, exist_ok=True)
FONTS = {
    (False, False): '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    (True, False): '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    (False, True): '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf',
}
_cache = {}

def width(s, size, bold=False, italic=False):
    key = (bold, italic)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(FONTS[key], 200)
    return _cache[key].getlength(s) * size / 200

# Print-safe palette (src/lib/documents/brand.js).
C = dict(teal='#007D90', navy='#06111F', tint='#E6F4F6', ink='#101820', muted='#6B7A87', white='#FFFFFF',
         stripe='#F4F7F8', faint='#D9E2E7', tile_line='#E1E8EC', dashed='#B8C4CC',
         paid='#1E8E5A', pending='#B8860B', failed='#C0392B')
FAMILY = "Arimo, 'Liberation Sans', Helvetica, Arial, sans-serif"


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.parts = w, h, []
        self.title = title

    def add(self, s):
        self.parts.append(s)

    def rect(self, x, y, w, h, fill, rx=0, stroke=None, sw=1, name=None):
        extra = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
        nid = f' id="{escape(name)}"' if name else ''
        self.add(f'<rect{nid} x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx}" fill="{fill}"{extra}/>')

    def text(self, x, baseline, s, size, color, bold=False, italic=False, align='left', box=None, name=None):
        """align within [x, x+box] (or around x for center without box)."""
        w = width(s, size, bold, italic)
        if align == 'center':
            tx = (x + (box - w) / 2) if box is not None else x - w / 2
        elif align == 'right':
            tx = (x + box - w) if box is not None else x - w
        else:
            tx = x
        weight = ' font-weight="700"' if bold else ''
        style = ' font-style="italic"' if italic else ''
        nid = f' id="{escape(name)}"' if name else ''
        self.add(f'<text{nid} x="{tx:.2f}" y="{baseline:.2f}" font-family="{FAMILY}" font-size="{size}"{weight}{style} fill="{color}">{escape(s)}</text>')
        return w

    def mark(self, x, y, size, color):
        k = size / 24
        self.add(f'<g id="Wi-Fi mark" transform="translate({x:.2f} {y:.2f}) scale({k:.4f})" fill="none">'
                 f'<circle cx="12" cy="19.68" r="2.16" fill="{color}"/>'
                 f'<path d="M6.821 14.678A7.2 7.2 0 0 1 17.179 14.678" stroke="{color}" stroke-width="2.4"/>'
                 f'<path d="M3.368 11.344A12 12 0 0 1 20.632 11.344" stroke="{color}" stroke-width="2.16"/>'
                 f'<path d="M-0.084 8.009A16.8 16.8 0 0 1 24.084 8.009" stroke="{color}" stroke-width="1.92"/></g>')

    def group(self, name):
        self.add(f'<g id="{escape(name)}">')

    def end(self):
        self.add('</g>')

    def save(self, filename):
        body = '\n'.join(self.parts)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}">\n'
               f'<title>{escape(self.title)}</title>\n{body}\n</svg>\n')
        with open(os.path.join(OUT, filename), 'w') as f:
            f.write(svg)
        return filename


# ---------------------------------------------------------------- receipts
def receipt(filename, title, brand, band, kicker, amount, state, fields, footer, footnote=None):
    W, H = 320, 560
    s = Svg(W, H, title)
    s.rect(0, 0, W, H, C['white'], name='Page')
    s.group('Header band')
    s.rect(0, 0, W, 92, band, name='Band')
    s.mark(W / 2 - 15, 14, 30, C['white'])
    s.text(14, 54 + 13.3, brand, 16, C['white'], bold=True, align='center', box=W - 28, name='Brand name')
    s.end()
    y = 92 + 14
    s.text(20, y + 6.6, kicker, 8, C['muted'], align='center', box=W - 40, name='Title')
    y += 8 * 1.5
    s.text(20, y + 22.4, amount, 27, C['navy'], bold=True, align='center', box=W - 40, name='Amount')
    y += 27 * 1.16 + 4
    color, label = {'paid': (C['paid'], 'PAID'), 'pending': (C['pending'], 'PENDING'), 'failed': (C['failed'], 'NOT COMPLETED')}[state]
    pw = width(label, 9, True) + 26
    s.group('Status pill')
    s.rect((W - pw) / 2, y, pw, 18, color, rx=9)
    s.text((W - pw) / 2, y + 12.4, label, 9, C['white'], bold=True, align='center', box=pw)
    s.end()
    y += 18 + 13
    s.group('Fields')
    for lbl, val in fields:
        lw = width(lbl + '  ', 8.5); vw = width(val, 8.5, True)
        x0 = (W - lw - vw) / 2
        s.text(x0, y + 7, lbl, 8.5, C['muted'])
        s.text(x0 + lw, y + 7, val, 8.5, C['ink'], bold=True)
        y += 8.5 * 1.15 + 2.5
    s.end()
    y += 10
    s.add(f'<line id="Dashed rule" x1="20" y1="{y:.2f}" x2="{W - 20}" y2="{y:.2f}" stroke="{C["dashed"]}" stroke-width="1" stroke-dasharray="3 2"/>')
    y += 16
    for line in ([footnote] if footnote else []) + footer:
        s.text(20, y + 6, line, 7.5, C['muted'], align='center', box=W - 40)
        y += 7.5 * 1.15 + 3
    return s.save(filename)


# ---------------------------------------------------------------- reports
def report(filename, title, brand, band, doc_title, range_label, kpis, columns, rows, landscape, money_keys=()):
    W, H = (842, 595) if landscape else (595, 842)
    s = Svg(W, H, title)
    s.rect(0, 0, W, H, C['white'], name='Page')
    # Header band: mark + "Brand — Title" centred as one lockup.
    s.group('Header band')
    s.rect(0, 0, W, 64, band, name='Band')
    head = f'{brand} — {doc_title}'
    size = 19
    while width(head, size, True) > W - 72 - 38 and size > 12:
        size -= 1
    tw = width(head, size, True)
    lx = (W - (28 + 10 + tw)) / 2
    s.mark(lx, 18 + (19 - size) / 2, 28, C['white'])
    s.text(lx + 38, 22 + (19 - size) * 0.6 + size * 0.84, head, size, C['white'], bold=True, name='Title')
    s.end()
    s.text(36, 64 + 14 + 8.4, f'{brand} · {range_label}', 10, C['muted'], align='center', box=W - 72, name='Subtitle')
    y = 64 + 14 + 10 * 1.16 + 12
    # KPI tiles.
    pw = W - 72
    gap = 10
    tile = (pw - gap * (len(kpis) - 1)) / len(kpis)
    s.group('KPI tiles')
    for i, (label, value) in enumerate(kpis):
        x = 36 + i * (tile + gap)
        s.rect(x, y, tile, 52, C['stripe'], rx=6, stroke=C['tile_line'])
        s.text(x + 10, y + 16.3, label.upper(), 7.5, C['muted'])
        s.text(x + 10, y + 37.4, value, 16, band, bold=True)
    s.end()
    y += 52 + 16
    # Table.
    total = sum(c[2] for c in columns)
    widths = [c[2] / total * pw for c in columns]
    s.group('Table header')
    s.rect(36, y, pw, 20, C['navy'])
    x = 36
    for (key, label, _, align), w in zip(columns, widths):
        s.text(x + 4, y + 13.2, label, 8.5, C['white'], bold=True, align=align, box=w - 8)
        x += w
    s.end()
    y += 20
    s.group('Table rows')
    for i, row in enumerate(rows):
        if i % 2 == 1:
            s.rect(36, y, pw, 16, C['stripe'])
        x = 36
        for (key, label, _, align), w in zip(columns, widths):
            value = str(row.get(key, ''))
            s.text(x + 4, y + 10.6, value, 8.5, C['ink'], align=align, box=w - 8)
            x += w
        y += 16
    s.end()
    y += 14
    s.text(36, y + 6.7, f'Generated 01 Oct 2026 · 09:40 am · Billed on Wi-Fi Fiti — M-Pesa hotspot billing', 8, C['muted'], italic=True, align='center', box=pw, name='Footer')
    return s.save(filename)


# ---------------------------------------------------------------- excel
def excel(filename, brand, band, doc_title, range_label, kpis, columns, rows):
    col_w = [86 if c[2] < 16 else 120 if c[2] < 26 else 170 for c in columns]
    while len(col_w) < 6:
        col_w.append(110)
    row_h = {1: 13, 2: 34, 3: 13, 4: 23, 5: 20, 6: 21, 7: 29, 8: 20}
    head_w, head_h = 38, 22
    grid_w = sum(col_w)
    n_rows = 9 + len(rows) + 2
    heights = [row_h.get(r, 20) for r in range(1, n_rows + 1)]
    W = head_w + grid_w + 1
    H = 34 + head_h + sum(heights) + 1
    s = Svg(W, H, f'{brand} — {doc_title} (Excel)')
    s.rect(0, 0, W, H, '#FFFFFF', name='Sheet')
    # Spreadsheet chrome: formula bar, column letters, row numbers.
    s.group('Spreadsheet chrome')
    s.rect(0, 0, W, 34, '#F3F4F6')
    s.text(10, 21, 'fx', 11, '#6B7280', italic=True)
    s.text(40, 21, f'{brand} — {doc_title}', 11, '#374151')
    s.rect(0, 34, W, head_h, '#F3F4F6', stroke='#D1D5DB', sw=0.6)
    x = head_w
    for i, w in enumerate(col_w):
        s.text(x, 34 + 15, chr(65 + i), 10, '#6B7280', align='center', box=w)
        s.add(f'<line x1="{x:.1f}" y1="34" x2="{x:.1f}" y2="{H}" stroke="#E5E7EB" stroke-width="0.6"/>')
        x += w
    y = 34 + head_h
    for r, h in enumerate(heights, start=1):
        s.rect(0, y, head_w, h, '#F3F4F6')
        s.text(0, y + h / 2 + 3.5, str(r), 9.5, '#6B7280', align='center', box=head_w)
        s.add(f'<line x1="0" y1="{y + h:.1f}" x2="{W}" y2="{y + h:.1f}" stroke="#E5E7EB" stroke-width="0.6"/>')
        y += h
    s.end()
    top = 34 + head_h
    row_y = [top]
    for h in heights:
        row_y.append(row_y[-1] + h)
    col_x = [head_w]
    for w in col_w:
        col_x.append(col_x[-1] + w)
    # Rows 1-3: brand band, mark in A2, title in C2.
    s.group('Header band (rows 1-3)')
    s.rect(head_w, row_y[0], grid_w, row_y[3] - row_y[0], band)
    s.mark(col_x[0] + 8, row_y[1] + 6, 24, C['white'])
    s.text(col_x[2] + 4, row_y[1] + 22.5, f'{brand} — {doc_title}', 15, C['white'], bold=True)
    s.end()
    s.text(col_x[0] + 4, row_y[3] + 15, f'{brand} · {range_label}', 10, C['muted'], italic=True, name='Range (row 4)')
    # KPI tiles in rows 6-7.
    span = max(1, len(col_w) // len(kpis))
    s.group('KPI tiles (rows 6-7)')
    for i, (label, value) in enumerate(kpis):
        a = i * span; b = len(col_w) if i == len(kpis) - 1 else a + span
        x0, x1 = col_x[a], col_x[b]
        s.rect(x0, row_y[5], x1 - x0, row_y[7] - row_y[5], C['stripe'], stroke=C['tile_line'], sw=0.8)
        s.text(x0 + 9, row_y[5] + 15, label.upper(), 9, C['muted'], bold=True)
        s.text(x0 + 9, row_y[6] + 18, value, 15, band, bold=True)
    s.end()
    # Header row 9 and data.
    s.group('Table (row 9 on)')
    s.rect(col_x[0], row_y[8], col_x[len(columns)] - col_x[0], heights[8], C['navy'])
    for i, (key, label, _, align) in enumerate(columns):
        s.text(col_x[i] + 6, row_y[8] + 14, label, 10, C['white'], bold=True, align=align, box=col_w[i] - 12)
    for j, row in enumerate(rows):
        ry = row_y[9 + j]
        if j % 2 == 1:
            s.rect(col_x[0], ry, col_x[len(columns)] - col_x[0], heights[9 + j], '#F7FAFB')
        for i, (key, label, _, align) in enumerate(columns):
            s.text(col_x[i] + 6, ry + 14, str(row.get(key, '')), 10, C['ink'], align=align, box=col_w[i] - 12)
    s.end()
    s.add(f'<rect x="{col_x[0] - 1}" y="{row_y[8] - 1}" width="{col_x[len(columns)] - col_x[0] + 2}" height="0" fill="none"/>')
    return s.save(filename)


files = []
files.append(receipt('01-customer-receipt.svg', 'Customer receipt — default brand', 'Kitale Cafe Wi-Fi', C['teal'],
    'HOTSPOT PAYMENT RECEIPT', 'KES 50', 'paid',
    [('Receipt no.', 'RCT-4K2Q9A'), ('Date', '01 Oct 2026 · 09:12 am'), ('Phone', '254712345678'), ('Package', '24 Hours'),
     ('M-Pesa code', 'SJK3XYZ123'), ('Hotspot', 'Kitale Stage')],
    ['Billed on Wi-Fi Fiti — M-Pesa hotspot billing', 'Support: 0712 345 678']))
files.append(receipt('02-customer-receipt-tenant-color.svg', 'Customer receipt — tenant brand color', 'Eldoret Net', '#5B3FC4',
    'HOTSPOT PAYMENT RECEIPT', 'KES 20', 'pending',
    [('Receipt no.', 'RCT-0Z81QX'), ('Date', '01 Oct 2026 · 11:40 am'), ('Phone', '254798765432'), ('Package', '1 Hour'),
     ('M-Pesa code', '—'), ('Hotspot', 'Eldoret Market')],
    ['Billed on Wi-Fi Fiti — M-Pesa hotspot billing']))
files.append(receipt('03-plan-receipt.svg', 'Wi-Fi Fiti plan receipt', 'Wi-Fi Fiti', C['teal'],
    'WI-FI FITI PLAN RECEIPT', 'KES 1,500', 'paid',
    [('Business', 'Kitale Cafe'), ('Plan', 'Hotspot users'), ('Paid on', '2026-09-01 10:00 UTC'), ('M-Pesa code', 'TST1234ABC'),
     ('Valid until', '2026-10-01 10:00 UTC'), ('Reference', 'ws_CO_010920261000')],
    ['Billed on Wi-Fi Fiti — M-Pesa hotspot billing'], footnote='Not a statutory tax invoice.'))

tx_rows = [
    dict(date='01 Oct 2026 · 09:12', loc='Kitale Stage', phone='254712345678', pkg='24 Hours', amount='KES 50', status='Paid', src='tuma', rcpt='SJK3XYZ123'),
    dict(date='01 Oct 2026 · 08:47', loc='Kitale Stage', phone='254798765432', pkg='1 Hour', amount='KES 20', status='Paid', src='tuma', rcpt='SJK2LMN456'),
    dict(date='30 Sep 2026 · 21:05', loc='Eldoret Market', phone='254701112233', pkg='Weekly', amount='KES 250', status='Paid', src='own', rcpt='SJI9PQR789'),
    dict(date='30 Sep 2026 · 19:31', loc='Kitale Stage', phone='254722334455', pkg='3 Hours', amount='KES 30', status='Failed', src='tuma', rcpt='—'),
    dict(date='30 Sep 2026 · 18:02', loc='Eldoret Market', phone='254733445566', pkg='24 Hours', amount='KES 50', status='Paid', src='own', rcpt='SJI7STU012'),
    dict(date='30 Sep 2026 · 16:44', loc='Kitale Stage', phone='254744556677', pkg='1 Hour', amount='KES 20', status='Paid', src='tuma', rcpt='SJI6VWX345'),
    dict(date='30 Sep 2026 · 12:15', loc='Kitale Stage', phone='254755667788', pkg='Monthly', amount='KES 800', status='Paid', src='tuma', rcpt='SJI3YZA678'),
    dict(date='29 Sep 2026 · 20:58', loc='Eldoret Market', phone='254766778899', pkg='3 Hours', amount='KES 30', status='Pending', src='own', rcpt='—'),
]
tx_cols = [('date', 'Date', 18, 'left'), ('loc', 'Location', 18, 'left'), ('phone', 'Phone', 16, 'left'), ('pkg', 'Package', 14, 'left'),
           ('amount', 'Amount', 12, 'right'), ('status', 'Status', 10, 'left'), ('src', 'Source', 10, 'left'), ('rcpt', 'M-Pesa code', 14, 'left')]
files.append(report('04-transactions-pdf.svg', 'Transactions — PDF (A4 landscape)', 'Kitale Cafe', C['teal'], 'Transactions', 'Last 30 days',
    [('Rows', '8'), ('Total amount', 'KES 1,250')], tx_cols, tx_rows, landscape=True))

rev_rows = [dict(pkg='Monthly', count='14', amount='KES 11,200'), dict(pkg='Weekly', count='38', amount='KES 9,500'),
            dict(pkg='24 Hours', count='412', amount='KES 20,600'), dict(pkg='3 Hours', count='118', amount='KES 3,540'),
            dict(pkg='1 Hour', count='170', amount='KES 3,400')]
files.append(report('05-revenue-report-pdf.svg', 'Revenue report — PDF (A4 portrait)', 'Kitale Cafe', C['teal'], 'Revenue report', '01 Sep 2026 – 01 Oct 2026',
    [('Total collected', 'KES 48,240'), ('Transactions', '752'), ('Customers', '388'), ('Avg. ticket', 'KES 64')],
    [('pkg', 'Package', 30, 'left'), ('count', 'Purchases', 18, 'right'), ('amount', 'Revenue', 20, 'right')], rev_rows, landscape=False))

pay_rows = [
    dict(date='2026-09-28', desc='Customer sales collected by Wi-Fi Fiti (64 payments, fee KES 160)', min='KES 3,040', mout='', status='Collected', ref=''),
    dict(date='2026-09-29', desc='Customer sales collected by Wi-Fi Fiti (71 payments, fee KES 182.5)', min='KES 3,467.5', mout='', status='Collected', ref=''),
    dict(date='2026-09-29', desc='Payout to Morgan Mfo (M-Pesa ••5678)', min='', mout='KES 5,000', status='Paid', ref='QWE123RTY'),
    dict(date='2026-09-30', desc='Customer sales collected by Wi-Fi Fiti (58 payments, fee KES 141)', min='KES 2,679', mout='', status='Collected', ref=''),
    dict(date='2026-10-01', desc='Payout to Kitale Cafe Ltd (bank ••6789)', min='', mout='KES 2,000', status='Waiting for review', ref=''),
]
files.append(report('06-payout-statement-pdf.svg', 'Payout statement — PDF (A4 landscape)', 'Kitale Cafe', C['teal'], 'Payout statement', 'Last 30 days',
    [('Collected for you (after fee)', 'KES 9,186.5'), ('Paid out', 'KES 5,000'), ('Waiting for review', 'KES 2,000'), ('Available now', 'KES 2,186.5')],
    [('date', 'Date', 14, 'left'), ('desc', 'Description', 44, 'left'), ('min', 'Money in', 14, 'right'), ('mout', 'Money out', 14, 'right'),
     ('status', 'Status', 16, 'left'), ('ref', 'Reference', 14, 'left')], pay_rows, landscape=True))

files.append(excel('07-transactions-excel.svg', 'Kitale Cafe', C['teal'], 'Transactions', 'Last 30 days',
    [('Rows', '8'), ('Total amount', 'KES 1,250')], tx_cols, tx_rows))
print('\n'.join(files))

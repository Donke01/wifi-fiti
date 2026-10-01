# Document designs (for Figma)

Editable designs of every receipt and report Wi-Fi Fiti produces, drawn to the
same sizes, colors and type as `src/lib/documents/` so design and code match.

| File | What it is | Size |
|---|---|---|
| 01-customer-receipt.svg | Customer receipt, default (teal) brand | 320 × 560 pt slip |
| 02-customer-receipt-tenant-color.svg | Customer receipt in a tenant's own brand color | 320 × 560 pt slip |
| 03-plan-receipt.svg | Wi-Fi Fiti plan receipt | 320 × 560 pt slip |
| 04-transactions-pdf.svg | Table exports as PDF (transactions shown) | A4 landscape, 842 × 595 pt |
| 05-revenue-report-pdf.svg | Revenue report PDF | A4 portrait, 595 × 842 pt |
| 06-payout-statement-pdf.svg | Payout statement PDF | A4 landscape |
| 07-transactions-excel.svg | How every Excel export is laid out | Spreadsheet view |

## Into Figma

Open the file *Wi-Fi Fiti — Receipts & Reports* and drag the SVGs onto the
canvas (or File → Place image). Text stays editable, shapes and colors stay
editable, and each part is a named layer (Header band, Status pill, Fields,
KPI tiles, Table header, Table rows). The file already has the colors as
variables (Document colors) and the reusable pieces (Wi-Fi mark, Status pill,
Receipt field, KPI tile).

Type is **Arimo**, which has the same letter widths as Helvetica, the font the
PDFs use.

## Colors (src/lib/documents/brand.js)

| Token | Hex | Used for |
|---|---|---|
| brand/teal | #007D90 | Header band and headline numbers (a tenant's own color replaces it) |
| brand/navy | #06111F | Amount on receipts, table header row |
| text/primary | #101820 | Body text |
| text/muted | #6B7A87 | Labels, subtitles, footers |
| surface/stripe | #F4F7F8 | Alternate table rows, KPI tiles |
| line/faint | #D9E2E7 | Hairlines |
| line/dashed | #B8C4CC | Receipt tear line |
| status/paid | #1E8E5A | PAID pill |
| status/pending | #B8860B | PENDING pill |
| status/failed | #C0392B | NOT COMPLETED pill |

## Regenerating

`python3 design/documents/make_designs.py` redraws all seven files (needs
Pillow and the Liberation Sans font, which has Arimo's metrics).

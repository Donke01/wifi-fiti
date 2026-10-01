# Document designs (for Figma)

The look for every receipt and report Wi-Fi Fiti produces. These replace the
first set: one typeface with character, a Wi-Fi signal motif, and no boxed
headers or all-caps labels.

| File | What it is | Size |
|---|---|---|
| 01-customer-receipt.svg | Customer receipt, default teal | 320 pt wide ticket |
| 02-customer-receipt-tenant-color.svg | The same receipt in a tenant's own color, waiting for M-Pesa | 320 pt wide ticket |
| 03-plan-receipt.svg | Wi-Fi Fiti plan receipt | 320 pt wide ticket |
| 04-transactions-pdf.svg | Every table export as PDF (transactions shown) | A4 landscape, 842 × 595 pt |
| 05-revenue-report-pdf.svg | Revenue report with share bars | A4 portrait, 595 × 842 pt |
| 06-payout-statement-pdf.svg | Payout statement | A4 landscape |
| 07-transactions-excel.svg | How every Excel export is laid out | Spreadsheet view |

## The idea

- **Signal arcs.** Wi-Fi rings radiate from a corner of each document in the
  tenant's color: bold on receipts, faint on reports.
- **Receipts are tickets.** The amount sits large on the brand color, with a
  status chip, then a tear-off perforation and the details below.
- **Reports lead with a figures strip.** One headline figure in the brand
  color, the rest beside it, split by hairlines instead of identical boxes.
- **Quiet tables.** Hairline rows, one ink rule under the header, colored
  status dots, share bars where a row is part of a total.

## Type

**Bricolage Grotesque** (SIL Open Font License, free on Google Fonts and in
Figma). ExtraBold for amounts and titles, SemiBold for values, Regular for
body text. Being OFL, it can be embedded in the generated PDFs.

## Colors

| Token | Hex | Used for |
|---|---|---|
| ink | #0E2A33 | Titles, values, header rule |
| muted | #5E7480 | Labels, footers |
| line | #DCE7E5 | Hairlines, perforation |
| paper | #F2F7F6 | Code panel, background |
| brand | #007D90 | Brand block, lead figure, arcs, bars (a tenant's color replaces it) |
| brand tint | #E3F2F3 | Bar track, Excel header row |
| mint | #8EE7D1 | Paid chip on the brand block |
| paid | #1E8E5A | Paid dot |
| pending | #C98A00 | Pending dot and chip |
| failed | #C0392B | Failed dot |

## Into Figma

Open *Wi-Fi Fiti — Receipts & Reports* and drag the SVGs onto the canvas.
Text, shapes and colors stay editable, and each part is a named layer
(Brand block, Status chip, Perforation, Figures, Table header, Table rows).

## Regenerating

`python3 design/documents/make_designs.py` redraws all seven files. It needs
Pillow and the Bricolage Grotesque TTFs, in `~/.fonts` or the folder named by
`BRICOLAGE_TTF_DIR`.

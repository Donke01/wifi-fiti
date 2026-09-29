'use strict';

/*
 * The Wi-Fi Fiti mark, drawn as vector shapes (arcs + dot) rather than
 * shipped as an image, so it always renders at print sharpness and can
 * take any color at call time - the platform's teal on an admin report,
 * white on a tenant's colored header band.
 *
 * pdfkit has no built-in "draw an open arc" primitive, so each bar is a
 * full ring stroked, then clipped to a wedge with a rotated rectangle -
 * the same trick used to fake a signal-strength icon in plain vector
 * drawing tools.
 */
function drawWifiMark(doc, { x, y, size = 24, color = '#007D90' } = {}) {
  const cx = x + size / 2;
  const cyBase = y + size * 0.82;
  const dot = size * 0.09;
  doc.save();
  doc.fillColor(color).circle(cx, cyBase, dot).fill();

  const rings = [size * 0.30, size * 0.50, size * 0.70];
  const widths = [size * 0.10, size * 0.09, size * 0.08];
  rings.forEach((r, i) => {
    doc.save();
    // Wedge clip: a wide triangle opening upward from the dot, so only the
    // top ~130 degrees of each ring shows - the classic Wi-Fi bars shape.
    const spread = r * 1.35;
    doc.moveTo(cx, cyBase)
      .lineTo(cx - spread, cyBase - r * 1.3)
      .lineTo(cx + spread, cyBase - r * 1.3)
      .closePath()
      .clip();
    doc.circle(cx, cyBase, r).lineWidth(widths[i]).strokeColor(color).stroke();
    doc.restore();
  });
  doc.restore();
}

module.exports = { drawWifiMark };

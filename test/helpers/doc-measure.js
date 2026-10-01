/* Text widths from the bundled font's advance widths, for layout tests and previews (no pdfkit needed). */
const metrics = require('../fixtures/bricolage-metrics.json');

function measure(text, size, weight = 400) {
  const table = metrics.weights[String(weight)] || metrics.weights['400'];
  let units = 0;
  for (const ch of String(text)) units += table[ch] != null ? table[ch] : table.n;
  return (units / metrics.unitsPerEm) * size;
}

module.exports = { measure };

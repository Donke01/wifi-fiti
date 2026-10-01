'use strict';

/*
 * Replays canvas pages as SVG: used for design previews and tests, so a
 * layout can be looked at without opening a PDF. Same shapes, same places.
 */

const WEIGHT_FAMILY = "'Bricolage Grotesque', sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => Number(v).toFixed(2).replace(/\.?0+$/, '') || '0';

function renderSvg(page) {
  let clip = 0;
  const defs = [];
  const body = page.ops.map((o) => {
    switch (o.op) {
      case 'text':
        return `<text x="${n(o.x)}" y="${n(o.y)}" font-family="${WEIGHT_FAMILY}" font-size="${o.size}" font-weight="${o.weight}" fill="${o.color}"${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}${o.opacity != null ? ` fill-opacity="${o.opacity}"` : ''} xml:space="preserve">${esc(o.text)}</text>`;
      case 'rect':
        return `<rect x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}" rx="${n(o.radius)}" fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.strokeWidth}"` : ''}${o.opacity != null ? ` fill-opacity="${o.opacity}"` : ''}/>`;
      case 'circle':
        return `<circle cx="${n(o.cx)}" cy="${n(o.cy)}" r="${n(o.r)}" fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.strokeWidth}"` : ''}/>`;
      case 'line':
        return `<line x1="${n(o.x1)}" y1="${n(o.y1)}" x2="${n(o.x2)}" y2="${n(o.y2)}" stroke="${o.color}" stroke-width="${o.width}"${o.dash ? ` stroke-dasharray="${o.dash.join(' ')}"` : ''}/>`;
      case 'path':
        return `<path d="${o.d}" fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${n(o.strokeWidth)}" stroke-linecap="${o.cap}"` : ''}/>`;
      case 'arcs': {
        const id = `c${clip += 1}`;
        const [x, y, w, h] = o.clip;
        defs.push(`<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath>`);
        return `<g clip-path="url(#${id})">${o.radii.map((r) => `<circle cx="${n(o.cx)}" cy="${n(o.cy)}" r="${n(r)}" fill="none" stroke="${o.color}" stroke-opacity="${o.opacity}" stroke-width="${o.width}"/>`).join('')}</g>`;
      }
      case 'push':
        return `<g transform="translate(${n(o.dx)} ${n(o.dy)})">`;
      case 'pop':
        return '</g>';
      default:
        return '';
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(page.width)}" height="${n(page.height)}" viewBox="0 0 ${n(page.width)} ${n(page.height)}">`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '') + body.join('\n') + '</svg>\n';
}

module.exports = { renderSvg };

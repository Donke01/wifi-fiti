'use strict';

// Tenant-owned captive-portal templates. This is intentionally separate from
// router provisioning: changing a template never changes bridge, Hotspot, or
// customer credentials. The active template is read by the public portal on
// its next request.
const crypto = require('node:crypto');

function attachTenantPortalTemplateRoutes(app, { businessAuth, db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_portal_templates (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      name TEXT NOT NULL,
      layout TEXT NOT NULL DEFAULT 'classic' CHECK(layout IN ('classic','cards','minimal')),
      accent_color TEXT NOT NULL DEFAULT '#1769D8',
      welcome_message TEXT NOT NULL DEFAULT '',
      show_packages INTEGER NOT NULL DEFAULT 1,
      show_utilities INTEGER NOT NULL DEFAULT 1,
      font_family TEXT NOT NULL DEFAULT 'modern',
      text_align TEXT NOT NULL DEFAULT 'center',
      package_style TEXT NOT NULL DEFAULT 'stacked',
      background_style TEXT NOT NULL DEFAULT 'aurora',
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_portal_templates_business
      ON tenant_portal_templates(business_id, active, updated_at);
  `);
  // These columns were added after the first template release. Keep the
  // migration local and idempotent so existing tenant databases upgrade on
  // boot without touching router or payment tables.
  const columns = db.prepare('PRAGMA table_info(tenant_portal_templates)').all().map(row => row.name);
  [['font_family', "TEXT NOT NULL DEFAULT 'modern'"], ['text_align', "TEXT NOT NULL DEFAULT 'center'"], ['package_style', "TEXT NOT NULL DEFAULT 'stacked'"], ['background_style', "TEXT NOT NULL DEFAULT 'aurora'"]].forEach(([name, definition]) => {
    if (!columns.includes(name)) db.exec(`ALTER TABLE tenant_portal_templates ADD COLUMN ${name} ${definition}`);
  });
  const id = () => `tpl_${crypto.randomBytes(12).toString('hex')}`;
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const own = (businessId, templateId) => db.prepare('SELECT * FROM tenant_portal_templates WHERE id=? AND business_id=?').get(templateId, businessId);
  const operator = handler => (req, res) => {
    const business = businessAuth(req, res); if (!business) return;
    try { return handler(req, res, business); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  };
  const validate = body => {
    const name = clean(body.name, 60); if (!name) throw new Error('Template name is required.');
    const layout = clean(body.layout, 20) || 'classic';
    if (!['classic','cards','minimal'].includes(layout)) throw new Error('Choose a valid portal layout.');
    const accent = clean(body.accentColor || body.accent_color, 20) || '#1769D8';
    if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error('Accent colour must be a six-digit hex colour.');
    const fontFamily = clean(body.fontFamily || body.font_family, 20) || 'modern';
    const textAlign = clean(body.textAlign || body.text_align, 20) || 'center';
    const packageStyle = clean(body.packageStyle || body.package_style, 20) || 'stacked';
    const backgroundStyle = clean(body.backgroundStyle || body.background_style, 20) || 'aurora';
    if (!['modern', 'rounded', 'condensed', 'mono'].includes(fontFamily)) throw new Error('Choose a valid font style.');
    if (!['left', 'center'].includes(textAlign)) throw new Error('Choose a valid text alignment.');
    if (!['stacked', 'tiles', 'compact', 'pill'].includes(packageStyle)) throw new Error('Choose a valid package style.');
    if (!['aurora', 'midnight', 'paper', 'sunset', 'mint'].includes(backgroundStyle)) throw new Error('Choose a valid background style.');
    return { name, layout, accentColor: accent.toUpperCase(), welcomeMessage: clean(body.welcomeMessage || body.welcome_message, 140), showPackages: body.showPackages === false ? 0 : 1, showUtilities: body.showUtilities === false ? 0 : 1, fontFamily, textAlign, packageStyle, backgroundStyle };
  };
  const publicTemplate = row => row && ({ id: row.id, name: row.name, layout: row.layout, accentColor: row.accent_color, welcomeMessage: row.welcome_message, showPackages: Boolean(row.show_packages), showUtilities: Boolean(row.show_utilities), fontFamily: row.font_family || 'modern', textAlign: row.text_align || 'center', packageStyle: row.package_style || 'stacked', backgroundStyle: row.background_style || 'aurora', active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at });
  app.get('/api/business/portal-templates', operator((req, res, business) => {
    const rows = db.prepare('SELECT * FROM tenant_portal_templates WHERE business_id=? ORDER BY active DESC,updated_at DESC').all(business.id);
    res.set('Cache-Control', 'no-store').json({ templates: rows.map(publicTemplate), active: publicTemplate(rows.find(row => row.active) || rows[0] || null) });
  }));
  app.post('/api/business/portal-templates', operator((req, res, business) => {
    const values = validate(req.body || {}); const templateId = id();
    db.prepare(`INSERT INTO tenant_portal_templates(id,business_id,name,layout,accent_color,welcome_message,show_packages,show_utilities,font_family,text_align,package_style,background_style,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(templateId, business.id, values.name, values.layout, values.accentColor, values.welcomeMessage, values.showPackages, values.showUtilities, values.fontFamily, values.textAlign, values.packageStyle, values.backgroundStyle, 0);
    res.status(201).json({ template: publicTemplate(own(business.id, templateId)) });
  }));
  app.patch('/api/business/portal-templates/:templateId', operator((req, res, business) => {
    const current = own(business.id, req.params.templateId); if (!current) return res.status(404).json({ error: 'Portal template not found.' });
    const values = validate(Object.assign({}, current, req.body || {}));
    db.prepare(`UPDATE tenant_portal_templates SET name=?,layout=?,accent_color=?,welcome_message=?,show_packages=?,show_utilities=?,font_family=?,text_align=?,package_style=?,background_style=?,updated_at=datetime('now') WHERE id=? AND business_id=?`).run(values.name, values.layout, values.accentColor, values.welcomeMessage, values.showPackages, values.showUtilities, values.fontFamily, values.textAlign, values.packageStyle, values.backgroundStyle, current.id, business.id);
    res.json({ template: publicTemplate(own(business.id, current.id)) });
  }));
  app.post('/api/business/portal-templates/:templateId/activate', operator((req, res, business) => {
    const current = own(business.id, req.params.templateId); if (!current) return res.status(404).json({ error: 'Portal template not found.' });
    db.exec('BEGIN IMMEDIATE');
    try { db.prepare('UPDATE tenant_portal_templates SET active=0,updated_at=datetime(\'now\') WHERE business_id=?').run(business.id); db.prepare('UPDATE tenant_portal_templates SET active=1,updated_at=datetime(\'now\') WHERE id=? AND business_id=?').run(current.id, business.id); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ template: publicTemplate(own(business.id, current.id)) });
  }));
  app.delete('/api/business/portal-templates/:templateId', operator((req, res, business) => {
    const current = own(business.id, req.params.templateId); if (!current) return res.status(404).json({ error: 'Portal template not found.' });
    if (current.active) return res.status(409).json({ error: 'Activate another portal template before deleting this one.' });
    db.prepare('DELETE FROM tenant_portal_templates WHERE id=? AND business_id=?').run(current.id, business.id);
    res.status(204).end();
  }));
}

module.exports = { attachTenantPortalTemplateRoutes };

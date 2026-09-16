/**
 * WhatsApp Business Cloud API adapter.
 *
 * This module is deliberately independent from FitiSignal SMS. It only sends
 * when the Meta credentials are configured and never exposes the access token
 * through an API response or log message.
 */
const crypto = require('node:crypto');

const graphVersion = () => String(process.env.WHATSAPP_GRAPH_VERSION || 'v23.0').trim();
const phoneNumberId = () => String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const accessToken = () => String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
const verifyToken = () => String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();

function configured() { return Boolean(phoneNumberId() && accessToken()); }

function recipient(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) throw new Error('WhatsApp recipient number is invalid.');
  return digits;
}

async function send(payload) {
  if (!configured()) throw Object.assign(new Error('WhatsApp Cloud API is not configured.'), { code: 'WHATSAPP_NOT_CONFIGURED' });
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(phoneNumberId())}/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || 'WhatsApp message was rejected.'), { status: 502, provider: body });
  return body;
}

async function sendText({ to, body, previewUrl = false }) {
  const text = String(body || '').trim();
  if (!text || text.length > 4096) throw new Error('WhatsApp text must contain 1–4096 characters.');
  return send({ to: recipient(to), type: 'text', text: { preview_url: Boolean(previewUrl), body: text } });
}

async function sendTemplate({ to, name, languageCode = 'en_US', parameters = [] }) {
  const templateName = String(name || '').trim();
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) throw new Error('WhatsApp template name is invalid.');
  const values = Array.isArray(parameters) ? parameters.slice(0, 20).map(value => ({ type: 'text', text: String(value ?? '').slice(0, 1024) })) : [];
  const template = { name: templateName, language: { code: String(languageCode || 'en_US') } };
  if (values.length) template.components = [{ type: 'body', parameters: values }];
  return send({ to: recipient(to), type: 'template', template });
}

function validWebhookSignature(rawBody, signature) {
  const secret = String(process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!secret) return true;
  const supplied = String(signature || '').replace(/^sha256=/, '');
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', secret).update(String(rawBody || '')).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

function attachWhatsAppRoutes(app) {
  app.get('/api/whatsapp/status', (_req, res) => res.json({ configured: configured() }));
  app.get('/api/whatsapp/webhook', (req, res) => {
    if (!verifyToken() || String(req.query['hub.verify_token'] || '') !== verifyToken()) return res.sendStatus(403);
    return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  });
  // express.json is already mounted by the application. Meta's webhook body is
  // acknowledged quickly; event-specific notification handling will be added
  // through the tenant notification dispatcher.
  app.post('/api/whatsapp/webhook', (req, res) => {
    if (!validWebhookSignature(JSON.stringify(req.body || {}), req.get('X-Hub-Signature-256'))) return res.sendStatus(403);
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    const eventCount = entries.reduce((total, entry) => total + (Array.isArray(entry.changes) ? entry.changes.length : 0), 0);
    console.log(`[whatsapp] webhook received (${eventCount} change${eventCount === 1 ? '' : 's'})`);
    return res.sendStatus(200);
  });
}

module.exports = { configured, sendText, sendTemplate, validWebhookSignature, attachWhatsAppRoutes };

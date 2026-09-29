const config = require('../config');

async function sendEmail({ to, subject, html, text }) {
  if (config.email.provider !== 'resend') {
    throw Object.assign(new Error('Email delivery is not configured.'), { code: 'EMAIL_NOT_CONFIGURED' });
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: config.email.from, to: [to], subject, html, text }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || 'Email could not be sent.'), { status: 502, provider: body });
  return body;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function greetingFor(name) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Nairobi' }).format(new Date()));
  const salutation = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'there';
  return `${salutation} ${firstName}!`;
}

function verificationEmail(code, purpose, recipientName = '') {
  const action = purpose === 'register' ? 'create your Wi-Fi Fiti account' : purpose === 'reset' ? 'reset your Wi-Fi Fiti password' : 'sign in to Wi-Fi Fiti';
  const greeting = greetingFor(recipientName);
  const safeGreeting = escapeHtml(greeting);
  const safeCode = escapeHtml(code);
  const logo = `${config.domains.appUrl}/assets/wifi-fiti-logo.png`;
  const year = new Date().getFullYear();
  return {
    subject: 'Wi-Fi Fiti code',
    text: `${greeting}\n\nUse ${code} to ${action}. This code expires in 3 minutes. If you did not request it, you can safely ignore this email.\n\nWi-Fi Fiti\nReliable hotspot and PPPoE billing for your business.\n${year} Wi-Fi Fiti. All rights reserved.`,
    html: `<!doctype html><html><body style="margin:0;background:#f4f7fb;padding:28px 14px;color:#142746;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dce5f0;border-radius:18px;overflow:hidden;box-shadow:0 12px 35px rgba(24,55,95,.10)"><div style="padding:26px 30px;text-align:center;background:linear-gradient(135deg,#f7fbff,#eef5ff);border-bottom:1px solid #e5edf6"><img src="${escapeHtml(logo)}" alt="Wi-Fi Fiti" width="72" height="72" style="display:block;margin:0 auto 10px;object-fit:contain"><div style="font-size:24px;font-weight:800;letter-spacing:-.03em;color:#1769d8">Wi-Fi Fiti</div><div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6c7f99;margin-top:5px">Connect. Manage. Grow.</div></div><div style="padding:32px 30px"><p style="font-size:18px;font-weight:700;margin:0 0 20px">${safeGreeting}</p><p style="font-size:15px;line-height:1.65;margin:0 0 14px">Use the verification code below to ${escapeHtml(action)}:</p><div style="margin:22px 0;padding:18px;text-align:center;background:#f1f7ff;border:1px solid #cfe1f7;border-radius:12px"><span style="font-size:34px;line-height:1;font-weight:800;letter-spacing:9px;color:#1769d8">${safeCode}</span></div><p style="font-size:14px;line-height:1.6;color:#637792;margin:0">This code expires in <strong>3 minutes</strong>. If you did not request it, you can safely ignore this email.</p></div><div style="padding:20px 30px;background:#f8fafc;border-top:1px solid #e5edf6;text-align:center;color:#71829a;font-size:12px;line-height:1.6"><strong style="color:#405776">Wi-Fi Fiti</strong><br>Reliable hotspot and PPPoE billing for your business.<br><span style="color:#93a1b3">© ${year} Wi-Fi Fiti. All rights reserved.</span></div></div></body></html>`,
  };
}

/** A team invite (or a password reset link the owner made for a member). */
function inviteEmail({ link, businessName, ownerName, roleLabel, name, reset = false, days = 7 }) {
  const greeting = greetingFor(name);
  const business = businessName || 'a business';
  const line = reset
    ? `Use the link below to set a new password for ${business} on Wi-Fi Fiti.`
    : `${ownerName || 'The owner'} invited you to help run ${business} on Wi-Fi Fiti as ${roleLabel}. Use the link below to set your password.`;
  const note = `The link works once and expires in ${days} days. If you did not expect it, you can ignore this email.`;
  const button = reset ? 'Set a new password' : 'Join the team';
  return {
    subject: reset ? `Set a new Wi-Fi Fiti password for ${business}` : `Join ${business} on Wi-Fi Fiti`,
    text: `${greeting}\n\n${line}\n\n${link}\n\n${note}\n\nWi-Fi Fiti`,
    html: `<!doctype html><html><body style="margin:0;background:#f4f7fb;padding:28px 14px;color:#142746;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dce5f0;border-radius:18px;padding:30px"><div style="font-size:22px;font-weight:800;color:#1769d8;margin-bottom:18px">Wi-Fi Fiti</div><p style="font-size:17px;font-weight:700;margin:0 0 14px">${escapeHtml(greeting)}</p><p style="font-size:15px;line-height:1.6;margin:0 0 20px">${escapeHtml(line)}</p><p style="margin:0 0 20px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1769d8;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${escapeHtml(button)}</a></p><p style="font-size:13px;line-height:1.6;color:#637792;margin:0">${escapeHtml(note)}</p></div></body></html>`,
  };
}

module.exports = { sendEmail, verificationEmail, inviteEmail };

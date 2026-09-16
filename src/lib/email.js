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

function verificationEmail(code, purpose) {
  const action = purpose === 'register' ? 'create your WiFi Fiti account' : purpose === 'reset' ? 'reset your WiFi Fiti password' : 'sign in to WiFi Fiti';
  return {
    subject: `${code} is your WiFi Fiti verification code`,
    text: `Use ${code} to ${action}. This code expires in 3 minutes. If you did not request it, ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>WiFi Fiti</h2><p>Use this code to ${action}:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700"><b>${code}</b></p><p>This code expires in 3 minutes. If you did not request it, ignore this email.</p></div>`,
  };
}

module.exports = { sendEmail, verificationEmail };

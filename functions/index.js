/**
 * COBC Dispatch — Twilio WhatsApp Cloud Function
 * Firebase project: cobc-dispatch
 *
 * Receives a POST from the dispatch app frontend, reads member phone
 * numbers from Firestore, and sends WhatsApp messages via Twilio in
 * parallel.
 *
 * Environment variables (set via: firebase functions:secrets:set NAME):
 *   TWILIO_SID        — Twilio Account SID
 *   TWILIO_AUTH       — Twilio Auth Token
 *   TWILIO_WA_FROM    — Sender number, e.g. whatsapp:+14155238886
 *   WA_SHARED_KEY     — Shared secret, must match WA_SHARED_KEY in index.html
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const twilio = require('twilio');

admin.initializeApp();

// Declare secrets — Firebase will inject them at runtime
const twilioSid     = defineSecret('TWILIO_SID');
const twilioAuth    = defineSecret('TWILIO_AUTH');
const twilioWaFrom  = defineSecret('TWILIO_WA_FROM');
const waSharedKey   = defineSecret('WA_SHARED_KEY');

exports.sendWhatsApp = onRequest(
  {
    secrets: [twilioSid, twilioAuth, twilioWaFrom, waSharedKey],
    region: 'us-east1',       // closest to NJ
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true                // allows calls from GitHub Pages
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'POST only' });
      return;
    }

    const body = req.body;

    // ── Auth check ────────────────────────────────────────────────
    if (!body.key || body.key !== waSharedKey.value()) {
      res.status(403).json({ ok: false, error: 'bad key' });
      return;
    }

    const message = body.message;
    if (!message) {
      res.status(400).json({ ok: false, error: 'no message' });
      return;
    }

    // ── Resolve phone numbers from Firestore ──────────────────────
    let phones;
    try {
      phones = await resolvePhones(body);
    } catch (err) {
      console.error('resolvePhones error:', err);
      res.status(500).json({ ok: false, error: 'firestore read failed' });
      return;
    }

    if (!phones.length) {
      res.json({ ok: true, sent: 0, note: 'no matching phones' });
      return;
    }

    // ── Send in parallel via Twilio ───────────────────────────────
    const client = twilio(twilioSid.value(), twilioAuth.value());
    const from   = twilioWaFrom.value(); // e.g. "whatsapp:+14155238886"

    const results = await Promise.allSettled(
      phones.map(phone =>
        client.messages.create({
          from,
          to:   `whatsapp:${phone}`,
          body: message
        })
      )
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message || String(r.reason));

    console.log(`sendWhatsApp: sent ${sent}/${phones.length}`, errors.length ? { errors } : '');

    res.json({ ok: true, sent, total: phones.length, errors });
  }
);

// ═══════════════════════════════════════════════════════════════════
// resolvePhones — read Firestore members and filter by target
// ═══════════════════════════════════════════════════════════════════
async function resolvePhones(body) {
  const db = admin.firestore();
  const snap = await db.collection('members').get();
  const members = snap.docs.map(d => ({ _id: d.id, ...d.data() }));

  if (body.target === 'unit') {
    // Individual member — used for approval notifications
    const unitStr = String(body.unit || '').replace(/^BC-?/i, '');
    return members
      .filter(m => String(m.unit || '').replace(/^BC-?/i, '') === unitStr && m.phone)
      .map(m => normalizePhone(m.phone))
      .filter(Boolean);
  }

  if (body.target === 'dispatchers') {
    // Dispatchers + admins only — used for pending-response notifications
    return members
      .filter(m =>
        ['dispatch', 'admin'].includes((m.role || '').toLowerCase()) &&
        m.phone &&
        m.active !== false
      )
      .map(m => normalizePhone(m.phone))
      .filter(Boolean);
  }

  if (body.target === 'phones') {
    // Caller passed an explicit phone list (optional feature)
    return (body.phones || []).map(normalizePhone).filter(Boolean);
  }

  // 'all' — every active member with a phone number
  return members
    .filter(m => m.phone && m.active !== false)
    .map(m => normalizePhone(m.phone))
    .filter(Boolean);
}

// ─── Normalize to E.164 (+12015551234) ──────────────────────────────
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '+1' + digits;   // US/Canada no country code
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits; // trust whatever country code is present
}

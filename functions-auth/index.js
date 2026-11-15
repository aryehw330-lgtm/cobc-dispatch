/**
 * COBC Dispatch — login Cloud Function
 * Firebase project: cobc-dispatch
 *
 * getAuthToken — returns a Firebase custom token with {authorized:true} (what the
 * Firestore rules and the push server check) ONLY after real proof of membership:
 *
 *   { unit: "BC-38", pin: "1234" }   → PIN must belong to THAT unit (checked by the
 *                                       equipment backend's getMemberByPin).
 *                                       5 wrong tries per unit → 15-min lockout;
 *                                       too many wrong tries overall → all PIN logins
 *                                       pause for the rest of the hour (stops scripts).
 *   { googleIdToken: "<jwt>" }       → Google One Tap credential, verified with Google.
 *   { googleAccessToken: "<token>" } → Google button flow, verified with Google.
 *
 * Retired (2026-11-15): { email } alone and { pin } without unit — those let anyone
 * who knew a member's email, or guessed any PIN, log in as a member.
 *
 * Deploy:  firebase deploy --only functions:getAuthToken
 */

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();

// Equipment backend web app — source of truth for member data.
const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbwjnEHbt8v1aVKUO7361uc8XTodz5yBWGKoRgQ3H26UFOJeAQarVQAGaEuYj277Ed14rw/exec';

// The dispatch app's Google sign-in client (index.html GOOGLE_CLIENT_ID).
const GOOGLE_CLIENT_ID = '292943991082-m13o9bee38d96s6f1vl3pk5oco8jojcr.apps.googleusercontent.com';

const UNIT_MAX_FAILS   = 5;                 // per unit
const UNIT_WINDOW_MS   = 15 * 60 * 1000;    // 15 minutes
const GLOBAL_MAX_FAILS = 40;                // all units together
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;    // 1 hour

function normUnit(u) { return String(u || '').trim().toUpperCase().replace(/^BC-?/, '').replace(/^0+(?=\d)/, ''); }

// ── PIN-attempt throttle (Firestore, server-only collection) ──────────────────
async function throttleState(key, windowMs) {
  const ref = admin.firestore().collection('authThrottle').doc(key);
  const snap = await ref.get();
  const d = snap.exists ? snap.data() : {};
  const now = Date.now();
  if (!d.start || now - d.start > windowMs) return { ref, fails: 0, start: now };
  return { ref, fails: d.fails || 0, start: d.start };
}
async function addFail(st) {
  await st.ref.set({ fails: st.fails + 1, start: st.start, last: Date.now() }, { merge: true });
}

// ── Google verification (no extra libraries: Google's tokeninfo endpoint) ────
async function emailFromGoogle(idToken, accessToken) {
  const q = idToken ? ('id_token=' + encodeURIComponent(idToken))
                    : ('access_token=' + encodeURIComponent(accessToken));
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?' + q);
  if (!r.ok) return null;
  const t = await r.json();
  const aud = t.aud || t.azp || t.issued_to;
  if (aud !== GOOGLE_CLIENT_ID && t.azp !== GOOGLE_CLIENT_ID) return null;   // token made for OUR app
  if (Number(t.exp || 0) * 1000 < Date.now()) return null;                  // not expired
  if (!(t.email_verified === true || t.email_verified === 'true' ||
        t.verified_email === true || t.verified_email === 'true')) return null;
  return String(t.email || '').trim().toLowerCase() || null;
}

exports.getAuthToken = onRequest(
  { region: 'us-east1', timeoutSeconds: 30, memory: '256MiB', cors: true },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')    { res.status(405).json({ ok: false, error: 'POST only' }); return; }

    const body = req.body || {};
    const pin = body.pin ? String(body.pin).trim() : '';
    const unit = normUnit(body.unit);
    let memberData = null;

    try {
      if (pin) {
        // ── PIN + unit ─────────────────────────────────────────────────────
        if (!unit) { res.status(400).json({ ok: false, error: 'unit required with PIN' }); return; }
        const g = await throttleState('global', GLOBAL_WINDOW_MS);
        if (g.fails >= GLOBAL_MAX_FAILS) {
          res.status(429).json({ ok: false, error: 'Too many failed sign-ins. Try again later.' }); return;
        }
        const u = await throttleState('unit_' + unit, UNIT_WINDOW_MS);
        if (u.fails >= UNIT_MAX_FAILS) {
          res.status(429).json({ ok: false, error: 'Too many wrong PINs for this unit. Wait 15 minutes.' }); return;
        }
        const r = await fetch(APPS_SCRIPT_URL + '?action=getMemberByPin&pin=' + encodeURIComponent(pin) +
                              '&unit=' + encodeURIComponent('BC-' + unit), { redirect: 'follow' });
        const j = await r.json();
        if (j && j.id && normUnit(j.id) === unit) {
          memberData = j;
        } else {
          await addFail(u); await addFail(g);
        }

      } else if (body.googleIdToken || body.googleAccessToken) {
        // ── Google sign-in (verified with Google) ─────────────────────────
        const email = await emailFromGoogle(body.googleIdToken, body.googleAccessToken);
        if (!email) { res.status(401).json({ ok: false, error: 'Google sign-in could not be verified' }); return; }
        const r = await fetch(APPS_SCRIPT_URL + '?action=checkMemberEmail&email=' + encodeURIComponent(email),
                              { redirect: 'follow' });
        const j = await r.json();
        if (j && j.authorized && j.id) memberData = Object.assign({ email: email }, j);

      } else {
        res.status(400).json({ ok: false, error: 'unit + PIN, or Google sign-in, required' }); return;
      }
    } catch (err) {
      console.error('verification failed:', err);
      res.status(500).json({ ok: false, error: 'Verification service unavailable' });
      return;
    }

    if (!memberData) { res.status(401).json({ ok: false, error: 'Not authorized' }); return; }

    // Don't send secrets back to the browser (session pass / PIN fields from the backend).
    const safeMember = {
      id: memberData.id, unit: memberData.unit || memberData.id, name: memberData.name,
      first: memberData.first, last: memberData.last, status: memberData.status,
      email: memberData.email, sess: memberData.sess
    };

    const uid = 'member-' + normUnit(memberData.id);
    const claims = {
      authorized: true,
      unit: memberData.id || memberData.unit || '',
      role: String(memberData.status || 'member').toLowerCase()
    };
    let customToken;
    try {
      customToken = await admin.auth().createCustomToken(uid, claims);
    } catch (err) {
      console.error('createCustomToken failed:', err);
      res.status(500).json({ ok: false, error: 'Token generation failed' });
      return;
    }
    res.json({ ok: true, token: customToken, member: safeMember });
  }
);

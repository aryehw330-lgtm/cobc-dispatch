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
 *   { action: "pk…" }                → Face ID / fingerprint (passkeys), see handlePasskey.
 *
 * Retired (2026-11-15): { email } alone and { pin } without unit — those let anyone
 * who knew a member's email, or guessed any PIN, log in as a member.
 *
 * Deploy:  firebase deploy --only functions:getAuthToken
 */

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

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

// ── Face ID / fingerprint (passkeys) ──────────────────────────────────────────
// The phone's biometric unlocks a private key that never leaves the device; the
// server stores only the matching PUBLIC key (Firestore 'passkeys') and checks a
// signed, single-use challenge before issuing the member login.
const RP_ID     = 'aryehw330-lgtm.github.io';
const RP_ORIGIN = 'https://aryehw330-lgtm.github.io';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

async function memberFromIdToken(req) {
  const h = String(req.get('Authorization') || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  try {
    const d = await admin.auth().verifyIdToken(tok);
    if (d.authorized !== true || !d.unit) return null;
    return { unit: normUnit(d.unit), role: d.role || 'member' };
  } catch (e) { return null; }
}
// The equipment server only gives the member list to signed-in phones or to this server.
// This server proves who it is with a Google-signed identity token for its own service
// account (no shared secret). Cached until shortly before it expires.
let _svcTok = null, _svcTokExp = 0;
async function _svcIdentity() {
  if (_svcTok && Date.now() < _svcTokExp) return _svcTok;
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=cobc-equipment-read&format=full',
      { headers: { 'Metadata-Flavor': 'Google' } });
    if (!r.ok) return '';
    _svcTok = (await r.text()).trim(); _svcTokExp = Date.now() + 45 * 60 * 1000;
    return _svcTok;
  } catch (e) { return ''; }
}
async function _membersUrl() {
  const t = await _svcIdentity();
  return APPS_SCRIPT_URL + '?action=getMembers' + (t ? '&svc=' + encodeURIComponent(t) : '');
}
async function memberByUnit(unit) {
  const r = await fetch(await _membersUrl(), { redirect: 'follow' });
  const j = await r.json();
  const m = (j.members || []).find(x => normUnit(x.id || x.unit) === unit);
  return m || null;
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
// A member who was removed and later re-added gets their login turned back on.
async function ensureLoginEnabled(uid) {
  try { const u = await admin.auth().getUser(uid); if (u.disabled) await admin.auth().updateUser(uid, { disabled: false }); }
  catch (e) { /* user-not-found: first sign-in, nothing to do */ }
}

async function handlePasskey(req, res, body) {
  const db = admin.firestore();
  const act = body.action;

  // Signed-in member: start / finish setting up Face ID on this phone.
  if (act === 'pkRegOptions' || act === 'pkRegVerify' || act === 'pkList' || act === 'pkRemove') {
    const me = await memberFromIdToken(req);
    if (!me) { res.status(401).json({ ok: false, error: 'Sign in first' }); return; }
    const mine = await db.collection('passkeys').where('unit', '==', me.unit).get();

    if (act === 'pkList') {
      res.json({ ok: true, passkeys: mine.docs.map(d => ({ id: d.id, device: d.data().device || '', createdAt: d.data().createdAt || 0 })) });
      return;
    }
    if (act === 'pkRemove') {
      const id = String(body.id || '');
      const doc = mine.docs.find(d => d.id === id);
      if (doc) await doc.ref.delete();
      res.json({ ok: true, removed: !!doc });
      return;
    }
    if (act === 'pkRegOptions') {
      const options = await generateRegistrationOptions({
        rpName: 'COBC Dispatch', rpID: RP_ID,
        userName: 'BC-' + me.unit, userDisplayName: 'BC-' + me.unit,
        userID: new TextEncoder().encode('member-' + me.unit),
        attestationType: 'none',
        excludeCredentials: mine.docs.map(d => ({ id: d.id, transports: d.data().transports || [] })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' },
      });
      await db.collection('pkChallenges').doc('reg_' + me.unit).set({ challenge: options.challenge, exp: Date.now() + CHALLENGE_TTL_MS });
      res.json({ ok: true, options });
      return;
    }
    // pkRegVerify
    const chRef = db.collection('pkChallenges').doc('reg_' + me.unit);
    const ch = await chRef.get();
    await chRef.delete().catch(() => {});
    if (!ch.exists || ch.data().exp < Date.now()) { res.status(400).json({ ok: false, error: 'Setup timed out — try again' }); return; }
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: body.response, expectedChallenge: ch.data().challenge,
        expectedOrigin: RP_ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
      });
    } catch (e) { res.status(400).json({ ok: false, error: 'Face ID setup could not be verified' }); return; }
    if (!v.verified || !v.registrationInfo) { res.status(400).json({ ok: false, error: 'Face ID setup could not be verified' }); return; }
    const c = v.registrationInfo.credential;
    await db.collection('passkeys').doc(c.id).set({
      unit: me.unit, publicKey: b64u(c.publicKey), counter: c.counter || 0,
      transports: c.transports || [], device: String(body.device || '').slice(0, 80), createdAt: Date.now(),
    });
    res.json({ ok: true });
    return;
  }

  // Signed-out: sign in with Face ID.
  if (act === 'pkAuthOptions') {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });
    const ref = db.collection('pkChallenges').doc();
    await ref.set({ challenge: options.challenge, exp: Date.now() + CHALLENGE_TTL_MS });
    res.json({ ok: true, options, challengeId: ref.id });
    return;
  }
  if (act === 'pkAuthVerify') {
    const chRef = db.collection('pkChallenges').doc(String(body.challengeId || 'x'));
    const ch = await chRef.get();
    await chRef.delete().catch(() => {});
    if (!ch.exists || ch.data().exp < Date.now()) { res.status(400).json({ ok: false, error: 'Sign-in timed out — try again' }); return; }
    const credId = String((body.response && body.response.id) || '');
    const pkRef = db.collection('passkeys').doc(credId || 'x');
    const pk = await pkRef.get();
    if (!credId || !pk.exists) { res.status(401).json({ ok: false, error: 'This Face ID is not set up for COBC on this phone. Sign in with your PIN, then set it up in Settings.' }); return; }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: body.response, expectedChallenge: ch.data().challenge,
        expectedOrigin: RP_ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
        credential: { id: credId, publicKey: Buffer.from(pk.data().publicKey, 'base64url'), counter: pk.data().counter || 0, transports: pk.data().transports || [] },
      });
    } catch (e) { res.status(401).json({ ok: false, error: 'Face ID could not be verified' }); return; }
    if (!v.verified) { res.status(401).json({ ok: false, error: 'Face ID could not be verified' }); return; }
    await pkRef.update({ counter: v.authenticationInfo.newCounter || 0, lastUsed: Date.now() });

    const unit = pk.data().unit;
    const m = await memberByUnit(unit);
    if (!m) { res.status(401).json({ ok: false, error: 'Not on the member list anymore' }); return; }
    await ensureLoginEnabled('member-' + unit);
    const token = await admin.auth().createCustomToken('member-' + unit, {
      authorized: true, unit: m.id || unit, role: String(m.status || m.role || 'member').toLowerCase(),
    });
    res.json({ ok: true, token, member: m });
    return;
  }
  res.status(400).json({ ok: false, error: 'unknown action' });
}

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
    if (typeof body.action === 'string' && body.action.startsWith('pk')) {
      try { await handlePasskey(req, res, body); }
      catch (e) { console.error('passkey error:', e); res.status(500).json({ ok: false, error: 'Face ID service error' }); }
      return;
    }
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
      await ensureLoginEnabled(uid);
      customToken = await admin.auth().createCustomToken(uid, claims);
    } catch (err) {
      console.error('createCustomToken failed:', err);
      res.status(500).json({ ok: false, error: 'Token generation failed' });
      return;
    }
    res.json({ ok: true, token: customToken, member: safeMember });
  }
);


// ── Cut off removed members (runs every hour) ─────────────────────────────────
// Anyone whose BC# is no longer on the member sheet has their app login turned off
// on every phone (their current sign-in stops working within an hour). If they are
// added back, their next sign-in turns it on again.
// Safety: if the member list can't be read or looks wrong (fewer than 50 people),
// it does nothing — a glitch must never sign everyone out.
exports.cutOffRemovedMembers = onSchedule({ schedule: 'every 60 minutes', region: 'us-east1', timeZone: 'America/New_York' }, async () => {
  let roster; const names = {};
  try {
    const r = await fetch(await _membersUrl(), { redirect: 'follow' });
    const j = await r.json();
    roster = new Set((j.members || []).map(m => normUnit(m.id || m.unit)).filter(Boolean));
    (j.members || []).forEach(m => { const u = normUnit(m.id || m.unit); if (u) names[u] = String(m.name || ((m.firstName || '') + ' ' + (m.lastName || ''))).toLowerCase().replace(/[^a-z]/g, ''); });
  } catch (e) { console.error('cutOff: roster fetch failed, skipping', e); return; }
  if (roster.size < 50) { console.error('cutOff: roster looks wrong (' + roster.size + '), skipping'); return; }

  let next, cut = [];
  do {
    const page = await admin.auth().listUsers(1000, next);
    for (const u of page.users) {
      if (!u.uid.startsWith('member-') || u.disabled) continue;
      const unit = normUnit(u.uid.slice(7));
      if (unit && !roster.has(unit)) {
        await admin.auth().updateUser(u.uid, { disabled: true });
        await admin.auth().revokeRefreshTokens(u.uid);
        cut.push('BC-' + unit);
      }
    }
    next = page.pageToken;
  } while (next);
  // Reassigned BC numbers (Nov 2026): if the name on a BC# changed since the last run, the
  // number went to a different person — sign out every phone still signed in as that BC#
  // (the old member's session ends within the hour; the new member signs in with their PIN).
  // The name list is kept server-side only (serverState is blocked to all app users).
  const reassigned = [];
  try {
    const ref = admin.firestore().collection('serverState').doc('rosterNames');
    const prevDoc = await ref.get();
    const prev = prevDoc.exists ? (prevDoc.data().names || {}) : null;
    if (prev) {
      for (const u of Object.keys(names)) {
        if (prev[u] && names[u] && prev[u] !== names[u]) {
          try { await admin.auth().revokeRefreshTokens('member-' + u); reassigned.push('BC-' + u); }
          catch (e) { if (e.code !== 'auth/user-not-found') console.error('cutOff: revoke failed BC-' + u, e); }
        }
      }
    }
    await ref.set({ names, at: Date.now() });
  } catch (e) { console.error('cutOff: reassigned check failed', e); }
  console.log('cutOff: roster=' + roster.size + ' cut off=' + (cut.join(', ') || 'none') + ' reassigned (signed out)=' + (reassigned.join(', ') || 'none'));
});


// ── Full monthly backup (runs nightly; writes once per month) ─────────────────
// Copies EVERY call plus the logs, stats and settings into fullBackups/<YYYY-MM>,
// gzipped and split into parts under the 1 MB document limit. The database rules
// block fullBackups from every app user (no rule matches it), so only this server
// code can read or write it. If a month's copy is missing or failed, the next
// night tries again. Keeps the last 24 months.
const zlib = require('zlib');
const FULL_BACKUP_COLLECTIONS = [
  'calls', 'auditLog', 'statsHistory', 'callerProfiles', 'commandHistory', 'commandLog',
  'commandLocations', 'config', 'members', 'callTypes', 'telzioCalls',
  'equipmentHistory', 'cobc4History', 'checklistHistory', 'reportHistory'
];
const FULL_BACKUP_KEEP_MONTHS = 24;
const PART_CHARS = 900000;

function _nyMonthKey(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(d);
  return p.find(x => x.type === 'year').value + '-' + p.find(x => x.type === 'month').value;
}

async function runFullBackup() {
  const db = admin.firestore();
  const key = _nyMonthKey(new Date());
  const head = db.collection('fullBackups').doc(key);
  const cur = await head.get();
  if (cur.exists && cur.data().complete) { console.log('fullBackup: ' + key + ' already done'); return; }

  const collections = {}, counts = {};
  for (const c of FULL_BACKUP_COLLECTIONS) {
    const snap = await db.collection(c).get();
    collections[c] = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    counts[c] = snap.size;
  }
  const json = JSON.stringify({ at: Date.now(), month: key, collections });
  const b64 = zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
  const parts = Math.ceil(b64.length / PART_CHARS);

  // Clear any half-written attempt, then write the parts, then mark complete.
  const old = await head.collection('parts').get();
  for (const d of old.docs) await d.ref.delete();
  for (let i = 0; i < parts; i++) {
    await head.collection('parts').doc(String(i).padStart(4, '0')).set({ i, data: b64.slice(i * PART_CHARS, (i + 1) * PART_CHARS) });
  }
  await head.set({ month: key, at: Date.now(), parts, counts, rawBytes: json.length, gzBase64Chars: b64.length, complete: true });
  console.log('fullBackup: ' + key + ' written — ' + parts + ' part(s), counts ' + JSON.stringify(counts));

  // Keep the newest 24 months.
  const all = await db.collection('fullBackups').orderBy('month', 'desc').get();
  const extra = all.docs.slice(FULL_BACKUP_KEEP_MONTHS);
  for (const d of extra) {
    const ps = await d.ref.collection('parts').get();
    for (const p of ps.docs) await p.ref.delete();
    await d.ref.delete();
    console.log('fullBackup: removed old ' + d.id);
  }
}

exports.monthlyFullBackup = onSchedule(
  { schedule: 'every day 03:15', region: 'us-east1', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '1GiB' },
  async () => { await runFullBackup(); }
);

// ═══════════════════════════════════════════════════════════════════════════
//  PFIS — SMS Confirmation Service  |  sms_service.js
//
//  Integrates with Africa's Talking sandbox for research/testing.
//  Sign up free at: https://account.africastalking.com/auth/register
//  Use sandbox mode — no real SMS charges, test phone numbers provided.
// ═══════════════════════════════════════════════════════════════════════════

const https = require('https');
const querystring = require('querystring');

// ── Config (loaded from environment or .env file) ───────────────────────────
const AT_CONFIG = {
  apiKey:   process.env.AT_API_KEY   || 'sandbox',          // your AT API key
  username: process.env.AT_USERNAME  || 'sandbox',          // your AT username
  sandbox:  process.env.AT_SANDBOX   !== 'false',           // true = use sandbox
};

const AT_SMS_URL = AT_CONFIG.sandbox
  ? 'api.sandbox.africastalking.com'
  : 'api.africastalking.com';

// Pending confirmations: txnId → { txn, timer, resolve, reject, expiresAt }
const pendingConfirmations = new Map();

const CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ── Send SMS via Africa's Talking ────────────────────────────────────────────
function sendSMS(to, message) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      username: AT_CONFIG.username,
      to,
      message,
      from: 'PFIS',   // sender ID (sandbox ignores this)
    });

    const options = {
      hostname: AT_SMS_URL,
      port:     443,
      path:     '/version1/messaging',
      method:   'POST',
      headers: {
        'Accept':        'application/json',
        'Content-Type':  'application/x-www-form-urlencoded',
        'apiKey':        AT_CONFIG.apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log(`[SMS] Sent to ${to}:`, parsed?.SMSMessageData?.Message || 'ok');
          resolve(parsed);
        } catch (e) {
          reject(new Error('SMS parse error: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('SMS timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Build confirmation message ────────────────────────────────────────────────
function buildMessage(txn) {
  const amount    = '₵' + Number(txn.amount).toLocaleString('en-GH', { minimumFractionDigits: 2 });
  const recipient = txn.recipient || 'Unknown Recipient';
  const ref       = txn.id;
  return (
    `PFIS ALERT: A transaction of ${amount} to ${recipient} was flagged on your account.\n` +
    `Reply YES to confirm or NO to cancel.\n` +
    `Ref: ${ref}\n` +
    `(Expires in 2 mins)`
  );
}

// ── Request customer confirmation ─────────────────────────────────────────────
//
//  Returns a Promise that resolves with:
//    { confirmed: true  } — customer replied YES
//    { confirmed: false } — customer replied NO
//    { confirmed: null  } — timed out (no reply)
//
async function requestConfirmation(txn, phoneNumber) {
  const message = buildMessage(txn);

  // Log always (even in simulation mode)
  console.log(`[SMS] Requesting confirmation from ${phoneNumber} for ${txn.id}`);
  console.log(`[SMS] Message: ${message}`);

  // Try to send real SMS; if AT not configured, fall through to simulation
  let smsSent = false;
  if (AT_CONFIG.apiKey !== 'sandbox' || AT_CONFIG.username !== 'sandbox') {
    try {
      await sendSMS(phoneNumber, message);
      smsSent = true;
    } catch (err) {
      console.warn('[SMS] Send failed, falling back to simulation:', err.message);
    }
  } else {
    console.log('[SMS] Sandbox/simulation mode — no real SMS sent.');
    smsSent = false;
  }

  // Register pending confirmation
  return new Promise((resolve) => {
    const expiresAt = Date.now() + CONFIRMATION_TIMEOUT_MS;

    const timer = setTimeout(() => {
      if (pendingConfirmations.has(txn.id)) {
        pendingConfirmations.delete(txn.id);
        console.log(`[SMS] Confirmation timeout for ${txn.id}`);
        resolve({ confirmed: null, reason: 'timeout' });
      }
    }, CONFIRMATION_TIMEOUT_MS);

    pendingConfirmations.set(txn.id, {
      txn,
      phoneNumber,
      timer,
      resolve,
      expiresAt,
      smsSent,
    });
  });
}

// ── Handle incoming SMS reply (called by webhook) ─────────────────────────────
function handleReply(from, text, txnId) {
  const reply = (text || '').trim().toUpperCase();

  // Try to find by explicit txnId or by phone number
  let entry = txnId ? pendingConfirmations.get(txnId) : null;

  if (!entry) {
    // Search by phone number (most recent pending for that number)
    for (const [id, e] of pendingConfirmations) {
      if (e.phoneNumber === from) {
        entry = e;
        txnId  = id;
        break;
      }
    }
  }

  if (!entry) {
    console.warn(`[SMS] Reply from ${from} ("${text}") — no matching pending confirmation.`);
    return { matched: false };
  }

  clearTimeout(entry.timer);
  pendingConfirmations.delete(txnId);

  const confirmed = reply === 'YES' || reply === 'Y';
  console.log(`[SMS] Reply for ${txnId}: "${reply}" → confirmed=${confirmed}`);
  entry.resolve({ confirmed, reason: 'customer_reply', reply });

  return { matched: true, txnId, confirmed };
}

// ── Simulate a reply (for research/demo without real SMS) ─────────────────────
function simulateReply(txnId, reply) {
  return handleReply(null, reply, txnId);
}

// ── Get all pending confirmations (for UI) ────────────────────────────────────
function getPending() {
  const result = [];
  for (const [id, e] of pendingConfirmations) {
    result.push({
      txnId:      id,
      phone:      e.phoneNumber,
      expiresAt:  e.expiresAt,
      secondsLeft: Math.max(0, Math.round((e.expiresAt - Date.now()) / 1000)),
      smsSent:    e.smsSent,
    });
  }
  return result;
}

module.exports = {
  requestConfirmation,
  handleReply,
  simulateReply,
  getPending,
  sendSMS,
  AT_CONFIG,
};

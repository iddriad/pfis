// ═══════════════════════════════════════════════════════════════════════════
//  PFIS — Predictive Fraud Intelligence System  |  server.js
//  Engine runs server-side — persists across page navigation
// ═══════════════════════════════════════════════════════════════════════════
const express   = require('express');
const path      = require('path');
const http      = require('http');
const { spawn } = require('child_process');
const sms       = require('./sms_service');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── IN-MEMORY STORE ────────────────────────────────────────────────────────
let transactions   = [];
let investigations = [];
let config = { threshSafe: 40, threshMod: 70, txnInterval: 2800 };

// ─── ENGINE STATE ────────────────────────────────────────────────────────────
let engineRunning  = false;
let engineInterval = null;
let txnCount       = 0;

// ─── PROFILES ────────────────────────────────────────────────────────────────
const PROFILES = [
  { id:'U-PF-001', name:'Kofi Mensah',    type:'Trader',   sub:'Frequent Sender',   avg:600,  hours:[8,18],  device:'Samsung Galaxy A54', location:'Kumasi',     initials:'KM', phone:'+233244000001' },
  { id:'U-PF-002', name:'Ama Boateng',     type:'Student',  sub:'Saver',             avg:120,  hours:[9,20],  device:'iPhone 13',          location:'Accra',      initials:'AB', phone:'+233244000002' },
  { id:'U-PF-003', name:'Kwame Asante',    type:'Worker',   sub:'Bill Payer',        avg:350,  hours:[7,21],  device:'Tecno Spark 10',     location:'Takoradi',   initials:'KA', phone:'+233244000003' },
  { id:'U-PF-004', name:'Akosua Frimpong', type:'Merchant', sub:'Bulk Receiver',     avg:1200, hours:[6,20],  device:'Xiaomi Redmi 12',    location:'Accra',      initials:'AF', phone:'+233244000004' },
  { id:'U-PF-005', name:'Yaw Darko',       type:'Worker',   sub:'Remittance Sender', avg:450,  hours:[8,19],  device:'Samsung Galaxy A32', location:'Kumasi',     initials:'YD', phone:'+233244000005' },
  { id:'U-PF-006', name:'Efua Ansah',      type:'Student',  sub:'Freelancer',        avg:200,  hours:[10,22], device:'Tecno Camon 20',     location:'Cape Coast', initials:'EA', phone:'+233244000006' },
];

const DEVICES = [
  'Samsung Galaxy A54','iPhone 13','Tecno Spark 10','Xiaomi Redmi 12',
  'Samsung Galaxy A32','Tecno Camon 20','Unknown Android Device','New iPhone','Unregistered Tablet',
];
const LOCATIONS = [
  'Accra','Kumasi','Takoradi','Tamale','Cape Coast',
  'Sunyani','Ho','Bolgatanga','Unknown Location','International IP',
];
const RECIPIENTS = [
  'MTN MoMo #0244-XXX','Vodafone Cash #0205-XXX','AirtelTigo #0277-XXX',
  'GCB Acct #1003-XXX','Ecobank #0038-XXX','New Recipient','Unknown Account','International Wire',
];
const FRAUD_TYPES = [
  'Account Takeover','SIM Swap','Smurfing','Mule Network',
  'Rapid Fire Transfers','Device Spoofing','Location Anomaly',
];

function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function uid() { return 'TXN-PFIS-' + Date.now().toString(36).toUpperCase(); }
function caseId() { return 'CASE-PFIS-' + Date.now().toString(36).toUpperCase(); }

// ─── ML SERVICE ──────────────────────────────────────────────────────────────
let mlReady = false;

function startMlService() {
  console.log('[server] Starting Python ML service...');
  const py = spawn('python3', ['ml_service.py'], { cwd: __dirname, env: { ...process.env } });
  py.stdout.on('data', d => {
    const msg = d.toString().trim();
    console.log('[ml]', msg);
    if (msg.includes('Starting Flask') || msg.includes('Running on')) mlReady = true;
  });
  py.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg.includes('Bootstrap complete')) mlReady = true;
    console.log('[ml]', msg);
  });
  py.on('exit', code => {
    console.warn('[server] ML exited with code', code, '— restarting in 3s...');
    mlReady = false;
    setTimeout(startMlService, 3000);
  });
  setTimeout(() => { mlReady = true; }, 15000);
}

function mlPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname:'127.0.0.1', port:5001, path:urlPath, method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} },
      (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} }); }
    );
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('ML timeout')); });
    req.write(payload); req.end();
  });
}

function mlGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname:'127.0.0.1', port:5001, path:urlPath }, (res) => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('ML timeout')); });
  });
}

function computeVelocity(profileId) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return transactions.filter(t => t.profile.id === profileId && t.ts >= cutoff).length;
}

function fallbackScore(txn) {
  const p = txn.profile; let score = 0;
  const hour = new Date(txn.ts).getHours();
  if (txn.amount > p.avg * 3)                                                           score += 30;
  if (hour < p.hours[0] || hour > p.hours[1])                                           score += 15;
  if (txn.device   !== p.device)                                                         score += 20;
  if (txn.location !== p.location)                                                       score += 15;
  if (['New Recipient','Unknown Account','International Wire'].includes(txn.recipient))   score += 20;
  score = Math.min(score, 100);
  const risk = score <= config.threshSafe ? 'safe' : score <= config.threshMod ? 'moderate' : 'high';
  return { score, risk, model_ready:false, top_factors:[], features:{}, fallback:true };
}

async function scoreTransaction(txn) {
  if (!mlReady) return fallbackScore(txn);
  try { return await mlPost('/score', { ...txn, velocity_1h: computeVelocity(txn.profile.id) }); }
  catch (err) { console.warn('[server] ML score failed:', err.message); return fallbackScore(txn); }
}

// ─── SERVER-SIDE ENGINE ──────────────────────────────────────────────────────
async function processTxn() {
  const profile = PROFILES[rand(0, PROFILES.length - 1)];
  const now     = Date.now();

  const useAnomalousDevice   = Math.random() < 0.25;
  const useAnomalousLocation = Math.random() < 0.25;
  const bigAmount            = Math.random() < 0.12;

  const baseAmount = rand(Math.round(profile.avg * 0.1), Math.round(profile.avg * 5));
  const amount     = bigAmount
    ? rand(Math.round(profile.avg * 4), Math.round(profile.avg * 10))
    : baseAmount;

  const txn = {
    id:        uid(),
    ts:        now,
    profile,
    amount,
    recipient: RECIPIENTS[rand(0, RECIPIENTS.length - 1)],
    device:    useAnomalousDevice
                 ? DEVICES.filter(d => d !== profile.device)[rand(0, DEVICES.length - 2)]
                 : profile.device,
    location:  useAnomalousLocation
                 ? LOCATIONS.filter(l => l !== profile.location)[rand(0, LOCATIONS.length - 2)]
                 : profile.location,
    failedHurdles: [],
    score:     0,
    risk:      'safe',
    status:    'approved',
    confirmed: null,
    fraudType: null,
    smsSent:   false,
    smsOutcome:null,
  };

  // Score via ML
  const ml = await scoreTransaction(txn);
  txn.score      = ml.score;
  txn.risk       = ml.risk;
  txn.mlScore    = ml.anomaly_score;
  txn.topFactors = ml.top_factors || [];
  txn.mlFeatures = ml.features    || {};
  txn.modelReady = ml.model_ready || false;
  txn.mlFallback = ml.fallback    || false;

  // Classify and respond
  if (txn.risk === 'safe') {
    txn.status    = 'approved';
    txn.confirmed = true;
    mlPost('/retrain', { txn, label: 'normal' }).catch(() => {});
  } else if (txn.risk === 'moderate') {
    txn.status = 'monitoring';
    txn.failedHurdles = txn.topFactors;
  } else {
    txn.status    = 'awaiting_customer';
    txn.confirmed = null;
    txn.fraudType = FRAUD_TYPES[rand(0, FRAUD_TYPES.length - 1)];
    txn.failedHurdles = txn.topFactors;
    triggerSmsConfirmation(txn);
  }

  transactions.unshift(txn);
  if (transactions.length > 500) transactions.pop();
  txnCount++;

  console.log(`[engine] ${txn.id} | ${txn.profile.name} | ₵${txn.amount} | ${txn.risk.toUpperCase()} (${txn.score})`);
}

function startEngine() {
  if (engineRunning) return { ok: false, message: 'Engine already running' };
  engineRunning  = true;
  processTxn();
  engineInterval = setInterval(processTxn, config.txnInterval);
  console.log('[engine] Started — interval:', config.txnInterval + 'ms');
  return { ok: true, message: 'Engine started' };
}

function stopEngine() {
  if (!engineRunning) return { ok: false, message: 'Engine not running' };
  clearInterval(engineInterval);
  engineInterval = null;
  engineRunning  = false;
  console.log('[engine] Stopped after', txnCount, 'transactions.');
  return { ok: true, message: 'Engine stopped' };
}

// ─── SMS CONFIRMATION ────────────────────────────────────────────────────────
async function triggerSmsConfirmation(txn) {
  const profile = PROFILES.find(p => p.id === txn.profile.id);
  if (!profile?.phone) return;
  txn.smsSent        = true;
  txn.smsRequestedAt = Date.now();

  sms.requestConfirmation(txn, profile.phone).then(({ confirmed }) => {
    const t = transactions.find(t => t.id === txn.id);
    if (!t) return;
    if (confirmed === true)  { t.status='approved';  t.confirmed=true;  t.smsOutcome='Customer confirmed via SMS'; mlPost('/retrain',{txn:t,label:'normal'}).catch(()=>{}); }
    if (confirmed === false) { t.status='cancelled'; t.confirmed=false; t.smsOutcome='Customer cancelled via SMS'; mlPost('/retrain',{txn:t,label:'fraud'}).catch(()=>{}); }
    if (confirmed === null)  { t.status='blocked';   t.confirmed=null;  t.smsOutcome='No reply — auto-blocked'; }
    t.smsResolvedAt = Date.now();
  });
}

// ─── ENGINE API ──────────────────────────────────────────────────────────────
app.post('/api/engine/start', (_req, res) => res.json(startEngine()));
app.post('/api/engine/stop',  (_req, res) => res.json(stopEngine()));
app.get('/api/engine/status', (_req, res) => res.json({
  running:     engineRunning,
  txnCount,
  txnInterval: config.txnInterval,
  mlReady,
}));

// ─── TRANSACTIONS ────────────────────────────────────────────────────────────
app.get('/api/transactions', (_req, res) => res.json(transactions));

// Keep POST endpoint for any client that still calls it (backwards compat)
app.post('/api/transactions', async (req, res) => {
  res.json({ ok: true, message: 'Engine is server-side. Use /api/engine/start instead.' });
});

app.get('/api/transactions/:id', (req, res) => {
  const t = transactions.find(t => t.id === req.params.id);
  t ? res.json(t) : res.status(404).json({ error: 'Not found' });
});

app.patch('/api/transactions/:id', async (req, res) => {
  const t = transactions.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  Object.assign(t, req.body);
  if (req.body.status==='approved'  || req.body.confirmed===true)  mlPost('/retrain',{txn:t,label:'normal'}).catch(()=>{});
  if (req.body.status==='cancelled' || req.body.confirmed===false) mlPost('/retrain',{txn:t,label:'fraud'}).catch(()=>{});
  res.json(t);
});

// ─── OTHER API ───────────────────────────────────────────────────────────────
app.get('/api/monitor',         (_req, res) => res.json(transactions.slice(0, 40)));
app.get('/api/profiles',        (_req, res) => res.json(PROFILES));
app.get('/api/investigations',  (_req, res) => res.json(investigations));
app.post('/api/investigations', (req, res)  => { investigations.unshift(req.body); res.json({ ok:true }); });

app.get('/api/reports', (_req, res) => {
  const stat = {
    total: transactions.length,
    safe:  transactions.filter(t=>t.risk==='safe').length,
    mod:   transactions.filter(t=>t.risk==='moderate').length,
    high:  transactions.filter(t=>t.risk==='high').length,
    saved: transactions.filter(t=>t.confirmed===false).reduce((a,t)=>a+t.amount,0),
    hfStats:{}, seg:{}, fTypes:{},
    mlReady:    transactions.filter(t=>t.modelReady).length,
    mlFallback: transactions.filter(t=>t.mlFallback).length,
    smsConfirmed: transactions.filter(t=>t.smsOutcome?.includes('confirmed')).length,
    smsCancelled: transactions.filter(t=>t.smsOutcome?.includes('cancelled')).length,
    smsTimeout:   transactions.filter(t=>t.smsOutcome?.includes('auto-blocked')).length,
  };
  transactions.forEach(t => {
    (t.topFactors||[]).forEach(f => { stat.hfStats[f]=(stat.hfStats[f]||0)+1; });
    const type = t.profile?.type||'Unknown';
    if (!stat.seg[type]) stat.seg[type]={safe:0,mod:0,high:0};
    if (t.risk==='safe')     stat.seg[type].safe++;
    if (t.risk==='moderate') stat.seg[type].mod++;
    if (t.risk==='high')     stat.seg[type].high++;
    if (t.fraudType) stat.fTypes[t.fraudType]=(stat.fTypes[t.fraudType]||0)+1;
  });
  res.json(stat);
});

app.get('/api/settings',  (_req, res) => res.json(config));
app.post('/api/settings', (req, res)  => {
  const prev = config.txnInterval;
  Object.assign(config, req.body);
  // If interval changed and engine is running, restart the timer
  if (engineRunning && config.txnInterval !== prev) {
    clearInterval(engineInterval);
    engineInterval = setInterval(processTxn, config.txnInterval);
    console.log('[engine] Interval updated to', config.txnInterval + 'ms');
  }
  res.json(config);
});

app.get('/api/ml/status', async (_req, res) => {
  try   { res.json({ ok:true, mlReady, models: await mlGet('/model/status') }); }
  catch { res.json({ ok:false, mlReady, error: 'ML service unavailable' }); }
});

app.post('/api/ml/bootstrap', async (req, res) => {
  try   { res.json(await mlPost('/bootstrap', { n: req.body?.n||200 })); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

// SMS
app.post('/webhook/sms', (req, res) => {
  const from = req.body.from||''; const text = req.body.text||'';
  const refMatch = text.match(/TXN-PFIS-[A-Z0-9]+/i);
  sms.handleReply(from, text, refMatch ? refMatch[0].toUpperCase() : null);
  res.status(200).send('');
});
app.post('/api/sms/simulate', (req, res) => {
  const { txnId, reply } = req.body;
  if (!txnId||!reply) return res.status(400).json({ error: 'txnId and reply required' });
  res.json(sms.simulateReply(txnId, reply));
});
app.get('/api/sms/pending', (_req, res) => res.json(sms.getPending()));
app.get('/api/sms/status',  (_req, res) => res.json({
  sandbox: sms.AT_CONFIG.sandbox, username: sms.AT_CONFIG.username,
  configured: sms.AT_CONFIG.apiKey !== 'sandbox' || sms.AT_CONFIG.username !== 'sandbox',
}));

app.get('/health', (_req, res) => res.json({ status:'ok', engineRunning, mlReady, transactions: transactions.length }));

// ─── PAGES ───────────────────────────────────────────────────────────────────
['/','/monitor','/transactions','/profiles','/investigations','/reports','/settings'].forEach(p => {
  app.get(p, (_req, res) =>
    res.sendFile(path.join(__dirname, 'views', p==='/' ? 'index.html' : p.slice(1)+'.html'))
  );
});

// ─── START ────────────────────────────────────────────────────────────────────
startMlService();
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n✅  PFIS running on port ' + PORT);
  console.log('    Engine: server-side (persists across page navigation)');
  console.log('    ML service starting on port 5001...\n');
});

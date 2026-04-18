#!/usr/bin/env node
/**
 * bollette-check.js
 * Recupera le bollette Sorgenia via API e invia promemoria Telegram con la data di scadenza reale.
 * Aggiorna automaticamente il refresh token su GitHub Secrets (via GITHUB_ENV) dopo ogni uso.
 *
 * Variabili d'ambiente richieste:
 *   SORGENIA_REFRESH_TOKEN — refresh token Sorgenia (ruotato ad ogni esecuzione)
 *   TELEGRAM_BOT_TOKEN     — token del bot Telegram
 *   TELEGRAM_CHAT_ID       — ID chat Telegram
 *
 * Variabili d'ambiente opzionali:
 *   GITHUB_ENV             — path al file env di GitHub Actions (per passare il nuovo RT al workflow)
 */

const fs = require('fs');

const BASIC_TOKEN = 'Basic QXBwX3NvcmdlbmlhOmdidnlvMW82cjJicDk1cWM1ZWk5ZDYxaW80dWg0OHNz';
const SUB_KEY = '9345cbf5a6844dc582af4df4bc135e2a';
const BASE_URL = 'https://api-prod.sorgenia.it';
const USERNAME = 'manferdini@gmail.com';
const CLIENTE = '5453891';

const BROWSER_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Origin': 'https://areaclienti.sorgenia.it',
  'Referer': 'https://areaclienti.sorgenia.it/',
  'Accept': 'application/json, text/plain, */*',
};

async function sorgeniaPost(path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { data, status: res.status };
}

async function doRefresh(rt) {
  const { data, status } = await sorgeniaPost(
    '/sorgenia/V6/refreshtoken',
    { username: USERNAME, sourceChannel: 'MYS' },
    { Authorization: BASIC_TOKEN, refreshToken: rt, 'Ocp-Apim-Subscription-Key': SUB_KEY }
  );
  if (status !== 200 || !data.accessToken) {
    throw new Error(`Refresh fallito HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { accessToken: data.accessToken, newRefreshToken: data.refreshToken };
}

function exportNewRT(newRT) {
  const envFile = process.env.GITHUB_ENV;
  if (envFile) {
    fs.appendFileSync(envFile, `NEW_SORGENIA_RT=${newRT}\n`);
    console.log('Nuovo RT esportato in GITHUB_ENV');
  }
}

async function getBills(accessToken) {
  const auth = {
    Authorization: `Bearer ${accessToken}`,
    'Ocp-Apim-Subscription-Key': SUB_KEY,
  };

  // 1. Prova bollette pagabili (tutte le forniture, con scadenza)
  const { data: p, status: s1 } = await sorgeniaPost(
    '/bollette/retrievePayableBills',
    { clientCode: CLIENTE, username: USERNAME },
    auth
  );
  console.log(`retrievePayableBills → ${s1}: ${JSON.stringify(p).slice(0, 400)}`);
  if (s1 === 200) {
    const list = p?.bills || p?.bollette || p?.list || p?.fatture || (Array.isArray(p) ? p : null);
    if (list && list.length > 0) return list;
  }

  // 2. Fallback: dashboard bollette
  const { data: d, status: s2 } = await sorgeniaPost(
    '/bollette/retrieveBillingDashboard',
    { clientCode: CLIENTE, username: USERNAME, pageNumber: 1 },
    auth
  );
  console.log(`retrieveBillingDashboard → ${s2}: ${JSON.stringify(d).slice(0, 400)}`);
  if (s2 === 200) {
    const list2 = d?.bills || d?.bollette || d?.list || d?.fatture || (Array.isArray(d) ? d : null);
    if (list2 && list2.length > 0) return list2;
  }

  // 3. Fallback: recuperoBollette LUCE (formato date MM/yyyy)
  const oggi = new Date();
  const mm = (n) => String(n + 1).padStart(2, '0');
  const start = `${mm(oggi.getMonth() - 1 < 0 ? 11 : oggi.getMonth() - 1)}/${oggi.getMonth() - 1 < 0 ? oggi.getFullYear() - 1 : oggi.getFullYear()}`;
  const end = `${mm(oggi.getMonth() + 1 > 11 ? 0 : oggi.getMonth() + 1)}/${oggi.getMonth() + 1 > 11 ? oggi.getFullYear() + 1 : oggi.getFullYear()}`;
  const { data: luce, status: s3 } = await sorgeniaPost(
    '/bollette/V4/recuperoBollette',
    { clientCode: CLIENTE, prCode: 'PR7224456', startDate: start, endDate: end },
    auth
  );
  console.log(`recuperoBollette LUCE → ${s3}: ${JSON.stringify(luce).slice(0, 400)}`);
  return luce?.bollette || luce?.list || (Array.isArray(luce) ? luce : []);
}

function formatDate(val) {
  if (!val) return null;
  const d = new Date(typeof val === 'number' ? val : val);
  if (isNaN(d)) return String(val);
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatEuro(val) {
  if (!val && val !== 0) return '';
  return ` — Euro ${parseFloat(val).toFixed(2)}`;
}

function buildMessage(bills) {
  const mese = new Date().toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

  if (!bills || bills.length === 0) {
    return [
      `*Promemoria Bollette Sorgenia* — ${mese}`,
      '',
      'Nessuna bolletta in scadenza trovata. Verifica manualmente:',
      'https://areaclienti.sorgenia.it/private/home',
      '',
      '_Promemoria automatico Gigio_',
    ].join('\n');
  }

  const lines = [`*Promemoria Bollette Sorgenia* — ${mese}`, ''];

  for (const b of bills.slice(0, 6)) {
    const tipo = String(b.servizio || b.commodity || b.tipo || b.prCode || '').toUpperCase();
    const isGas = tipo.includes('GAS') || tipo.startsWith('PDR');
    const emoji = isGas ? '\uD83D\uDD25' : '\uD83D\uDCA1';
    const label = isGas ? 'GAS' : 'LUCE';
    const scadenza = formatDate(b.dataScadenza || b.scadenza || b.dueDate || b.dataPagamento || b.expiryDate);
    const importo = formatEuro(b.importo || b.amount || b.totalAmount || b.importoTotale);
    const scadenzaStr = scadenza ? `Scadenza: *${scadenza}*${importo}` : `Importo: *${(b.importo || b.amount || '?')}*`;
    lines.push(`${emoji} *${label}* — Via Filippo Airaldi 82, Alassio`);
    lines.push(scadenzaStr);
    lines.push('');
  }

  lines.push('Archivio: https://areaclienti.sorgenia.it/private/home');
  lines.push('_Promemoria automatico Gigio_');
  return lines.join('\n');
}

async function sendTelegram(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: Number(chatId), text, parse_mode: 'Markdown' }),
  });
  const r = await res.json();
  if (!r.ok) throw new Error(`Telegram: ${JSON.stringify(r)}`);
  return r;
}

(async () => {
  const rt = process.env.SORGENIA_REFRESH_TOKEN;
  if (!rt) { console.error('SORGENIA_REFRESH_TOKEN mancante'); process.exit(1); }

  let accessToken, newRT;
  try {
    console.log('[1] Refresh token...');
    ({ accessToken, newRefreshToken: newRT } = await doRefresh(rt));
    console.log('[1] OK');
    exportNewRT(newRT);
  } catch (err) {
    const msg = `Gigio - Errore refresh Sorgenia: ${err.message}`;
    console.error(msg);
    try { await sendTelegram(msg); } catch {}
    process.exit(1);
  }

  let bills = [];
  try {
    console.log('[2] Recupero bollette...');
    bills = await getBills(accessToken);
    console.log(`[2] Trovate ${bills.length} bollette`);
  } catch (err) {
    console.warn('[2] Errore recupero bollette:', err.message);
  }

  const message = buildMessage(bills);
  console.log('[3] Messaggio:', message.slice(0, 150));

  try {
    await sendTelegram(message);
    console.log('[3] Telegram inviato OK');
  } catch (err) {
    console.error('[3] Telegram errore:', err.message);
    process.exit(1);
  }
})();

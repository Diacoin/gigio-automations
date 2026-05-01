/**
 * morning-report.js
 * Genera il report mattutino di Bits Legacy tramite Claude API
 * e lo invia al bot Telegram configurato.
 *
 * Variabili d'ambiente richieste:
 *   ANTHROPIC_API_KEY  — chiave API Anthropic
 *   TELEGRAM_BOT_TOKEN — token del bot Telegram
 *   TELEGRAM_CHAT_ID   — ID della chat dove inviare il report
 *   NOTION_TOKEN       — token integrazione Notion (per leggere task aperti)
 *   DEBUG_MODE         — 'true' per loggare senza inviare su Telegram
 */

const https = require('https');
const path = require('path');

let logTokenUsage;
try {
  ({ logTokenUsage } = require(path.join(__dirname, '..', '..', 'Cost-guardian', 'token-logger')));
} catch {
  logTokenUsage = () => {};
}

// ─── Configurazione ──────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const MODEL = 'claude-sonnet-4-6';

// ID del Task Board Notion — Bits Legacy
const NOTION_DB_ID = '34152f84-f26f-81e7-afa0-ec04f4b2ffae';

// Validazione variabili d'ambiente
function validateEnv() {
  const missing = [];
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');

  if (missing.length > 0) {
    console.error(`[ERRORE] Variabili d'ambiente mancanti: ${missing.join(', ')}`);
    console.error('Configura i GitHub Secrets corrispondenti e riprova.');
    process.exit(1);
  }

  if (!NOTION_TOKEN) {
    console.warn('[WARN] NOTION_TOKEN non configurato — task Notion non inclusi nel report.');
  }
}

// ─── Data italiana ────────────────────────────────────────────────────────────

function getItalianDate() {
  return new Date().toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ─── Chiamata generica HTTPS ──────────────────────────────────────────────────

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error(`Parsing risposta fallito: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Data odierna in formato YYYY-MM-DD (fuso italiano) ──────────────────────

function getTodayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

// ─── Lettura task aperti da Notion ────────────────────────────────────────────

async function queryNotion(filter, sorts, pageSize = 20) {
  if (!NOTION_TOKEN) return null;

  const body = JSON.stringify({ filter, sorts, page_size: pageSize });
  const options = {
    hostname: 'api.notion.com',
    path: `/v1/databases/${NOTION_DB_ID}/query`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    }
  };

  try {
    const { status, body: data } = await httpsRequest(options, body);
    if (status !== 200) {
      console.warn(`[WARN] Notion API ${status}: ${JSON.stringify(data)}`);
      return null;
    }
    return data.results || [];
  } catch (e) {
    console.warn(`[WARN] Errore query Notion: ${e.message}`);
    return null;
  }
}

function formatTask(page, showDeadline = true, showNote = true) {
  const props = page.properties;
  const taskName = props.Task?.title?.[0]?.text?.content || '(senza titolo)';
  const owner = props.Owner?.select?.name || '—';
  const stato = props.Stato?.select?.name || '—';
  const scadenza = props.Scadenza?.date?.start || '';
  const note = props.Note?.rich_text?.map(t => t.plain_text).join('') || '';

  const statoIcon = stato.includes('Bloccato') ? '🔴'
    : stato.includes('In corso') ? '🟡'
    : stato.includes('Da fare') ? '🔵'
    : stato.includes('In attesa') ? '⏸️'
    : '✅';

  const deadlineStr = (showDeadline && scadenza) ? ` · ⏰ ${scadenza}` : '';
  const noteStr = (showNote && note) ? `\n   📝 ${note}` : '';
  return `${statoIcon} *${taskName}*\n   👤 ${owner}${deadlineStr}${noteStr}`;
}

async function getOpenTasks() {
  if (!NOTION_TOKEN) return null;

  const results = await queryNotion(
    {
      filter: {
        property: 'Stato',
        select: { does_not_equal: '🟢 Completato' }
      }
    },
    [
      { property: 'Priorità', direction: 'ascending' },
      { property: 'Scadenza', direction: 'ascending' },
    ]
  );

  if (!results || results.length === 0) return null;
  return results.map(p => formatTask(p)).join('\n\n');
}

// ─── Task completati ieri ─────────────────────────────────────────────────────

function getYesterdayISO() {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }));
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

async function getTasksCompletedYesterday() {
  if (!NOTION_TOKEN) return null;

  const yesterday = getYesterdayISO();

  const results = await queryNotion(
    {
      and: [
        {
          timestamp: 'last_edited_time',
          last_edited_time: { equals: yesterday }
        },
        {
          property: 'Stato',
          select: { equals: '🟢 Completato' }
        }
      ]
    },
    [{ property: 'Priorità', direction: 'ascending' }]
  );

  if (!results || results.length === 0) return null;
  return results.map(p => formatTask(p, false, false)).join('\n\n');
}

// ─── Task in scadenza oggi ────────────────────────────────────────────────────

async function getTasksExpiringToday() {
  if (!NOTION_TOKEN) return null;

  const today = getTodayISO();

  const results = await queryNotion(
    {
      and: [
        {
          property: 'Scadenza',
          date: { equals: today }
        },
        {
          property: 'Stato',
          select: { does_not_equal: '🟢 Completato' }
        }
      ]
    },
    [{ property: 'Priorità', direction: 'ascending' }]
  );

  if (!results || results.length === 0) return null;
  return results.map(p => formatTask(p, false)).join('\n\n');
}

// ─── Chiamata API Anthropic ───────────────────────────────────────────────────

function callClaude(systemPrompt, userPrompt) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt }
    ]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body),
    }
  };

  return httpsRequest(options, body).then(({ status, body: data }) => {
    if (status !== 200) {
      throw new Error(`API Anthropic errore ${status}: ${JSON.stringify(data)}`);
    }
    const text = data.content?.[0]?.text;
    if (!text) throw new Error('Risposta API vuota o malformata');
    const u = data.usage || {};
    logTokenUsage('morning-report', u.input_tokens || 0, u.output_tokens || 0, MODEL, u.cache_read_input_tokens || 0);
    return text;
  });
}

// ─── Invio Telegram ───────────────────────────────────────────────────────────

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    // Telegram limita i messaggi a 4096 caratteri — tronca se necessario
    const safeText = text.length > 4000
      ? text.substring(0, 3950) + '\n\n[... report troncato per limite Telegram]'
      : text;

    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: safeText,
      parse_mode: 'Markdown',
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };

    httpsRequest(options, body).then(({ body: data }) => {
      if (!data.ok) reject(new Error(`Telegram API errore: ${JSON.stringify(data)}`));
      else resolve(data);
    }).catch(reject);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Report mattutino avviato`);
  console.log(`Modello: ${MODEL}`);
  console.log(`Debug mode: ${DEBUG_MODE}`);

  validateEnv();

  const oggi = getItalianDate();

  // Legge task da Notion in parallelo
  console.log('[0/3] Lettura task da Notion...');
  const [taskAperti, scadenzeOggi, taskIeri] = await Promise.all([
    getOpenTasks(),
    getTasksExpiringToday(),
    getTasksCompletedYesterday(),
  ]);

  console.log(`[0/3] Task aperti: ${taskAperti ? taskAperti.split('\n\n').length : 0}`);
  console.log(`[0/3] Scadenze oggi: ${scadenzeOggi ? scadenzeOggi.split('\n\n').length : 0}`);
  console.log(`[0/3] Completati ieri: ${taskIeri ? taskIeri.split('\n\n').length : 0}`);

  const scadenzeSection = scadenzeOggi
    ? `\n\n*SCADENZE OGGI — DA COMPLETARE ENTRO STASERA*\n${scadenzeOggi}`
    : '\n\n*SCADENZE OGGI*\nNessuna attività in scadenza oggi.';

  const taskSection = taskAperti
    ? `\n\n*TASK APERTI — NOTION BOARD*\n${taskAperti}`
    : '';

  const ieriSection = taskIeri
    ? `\n\n*COMPLETATI IERI — NOTION BOARD*\n${taskIeri}`
    : '\n\n*COMPLETATI IERI*\nNessun task completato ieri.';

  const systemPrompt = `Sei Kirk, supervisore tecnico del progetto Bits Legacy. \
Conosci il progetto dal CLAUDE.md. Ogni mattina produci \
un report conciso e operativo per il fondatore MarcoMan.`;

  const userPrompt = `Genera il report mattutino di Bits Legacy basandoti SOLO sui dati reali forniti qui sotto. Non inventare attività, stati o decisioni non presenti nei dati.

*BITS LEGACY — REPORT MATTUTINO ${oggi}*

*STATO PROGETTO*
Una riga sintetica derivata dai task aperti e dal loro stato.

*FATTO IERI*
Elenca i task completati ieri (vedi sezione COMPLETATI IERI). Se non ce ne sono, scrivi "Nessun task completato ieri registrato su Notion."

*BLOCCATO O IN ATTESA*
Elenca i task con stato Bloccato o In attesa dai task aperti. Massimo 3, con domanda diretta per sbloccarli. Se non ce ne sono, scrivi "Nessun blocco segnalato."

*PRIORITÀ OGGI*
Le 3 cose più urgenti dai task aperti (per priorità e scadenza), con agente responsabile (Owner).

*SCADENZE IMMINENTI*
Ricava dai task aperti le deadline più vicine.

*DECISIONE CHE MI SERVE OGGI*
Una sola cosa — la più importante da decidere oggi, ricavata dai dati.${ieriSection}${scadenzeSection}${taskSection}`;

  try {
    console.log('[1/3] Chiamata API Claude...');
    const report = await callClaude(systemPrompt, userPrompt);
    console.log('[1/3] Report generato con successo');
    console.log('\n--- ANTEPRIMA REPORT ---');
    console.log(report);
    console.log('--- FINE ANTEPRIMA ---\n');

    if (DEBUG_MODE) {
      console.log('[DEBUG] Modalità debug attiva — report NON inviato su Telegram.');
      console.log('Per inviarlo davvero, imposta DEBUG_MODE=false e riesegui.');
      process.exit(0);
    }

    console.log('[2/3] Invio su Telegram...');
    await sendTelegram(report);
    console.log('[2/3] Messaggio inviato con successo');

    console.log('[3/3] Report mattutino completato.');

  } catch (error) {
    console.error(`[ERRORE] ${error.message}`);
    // Prova ad inviare un alert di errore su Telegram
    try {
      await sendTelegram(
        `⚠️ *BITS LEGACY — ERRORE REPORT MATTUTINO*\n\n` +
        `Non sono riuscito a generare il report oggi.\n` +
        `Errore: \`${error.message}\`\n\n` +
        `Controlla i GitHub Actions per i dettagli.`
      );
    } catch (telegramError) {
      console.error(`Impossibile inviare alert Telegram: ${telegramError.message}`);
    }
    process.exit(1);
  }
}

main();

/**
 * morning-report.js
 * Genera il report mattutino di Bits Legacy tramite Claude API
 * e lo invia al bot Telegram configurato.
 *
 * Variabili d'ambiente richieste:
 *   ANTHROPIC_API_KEY  — chiave API Anthropic
 *   TELEGRAM_BOT_TOKEN — token del bot Telegram
 *   TELEGRAM_CHAT_ID   — ID della chat dove inviare il report
 *   DEBUG_MODE         — 'true' per loggare senza inviare su Telegram
 */

const https = require('https');

// ─── Configurazione ──────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const MODEL = 'claude-sonnet-4-6';

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

// ─── Chiamata API Anthropic ───────────────────────────────────────────────────

function callClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
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

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`API Anthropic errore ${res.statusCode}: ${JSON.stringify(parsed)}`));
            return;
          }
          const text = parsed.content?.[0]?.text;
          if (!text) {
            reject(new Error('Risposta API vuota o malformata'));
            return;
          }
          resolve(text);
        } catch (e) {
          reject(new Error(`Parsing risposta Claude fallito: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
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

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (!parsed.ok) {
          reject(new Error(`Telegram API errore: ${JSON.stringify(parsed)}`));
          return;
        }
        resolve(parsed);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Report mattutino avviato`);
  console.log(`Modello: ${MODEL}`);
  console.log(`Debug mode: ${DEBUG_MODE}`);

  validateEnv();

  const oggi = getItalianDate();

  const systemPrompt = `Sei Gigio, supervisore tecnico del progetto Bits Legacy. \
Conosci il progetto dal CLAUDE.md. Ogni mattina produci \
un report conciso e operativo per il fondatore MarcoMan.`;

  const userPrompt = `Genera il report mattutino di Bits Legacy nel formato:

*BITS LEGACY — REPORT MATTUTINO ${oggi}*

*STATO PROGETTO*
Una riga sullo stato attuale.

*FATTO IERI*
Attività completate (se nessuna, scrivilo).

*BLOCCATO O IN ATTESA*
Massimo 3 punti critici con domanda diretta per sbloccarli.

*PRIORITÀ OGGI*
3 cose più urgenti con agente responsabile.

*SCADENZE IMMINENTI*
Appuntamenti e deadline vicini.

*DECISIONE CHE MI SERVE OGGI*
Una sola cosa — la più importante.`;

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

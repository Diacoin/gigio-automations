/**
 * server.js
 * Express server — Telegram webhook receiver for Kirk bot.
 * Handles incoming messages, applies user whitelist, and routes to Claude.
 * All identifiers and comments in this file are in English.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const { askKirk, clearHistory } = require('./claude');
const { sendMessage, sendTypingAction, registerWebhook } = require('./telegram');

// ---------------------------------------------------------------------------
// Validate required environment variables
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_ALLOWED_USER_ID',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[server] ERRORE CRITICO: variabile d'ambiente mancante: ${key}`);
    process.exit(1);
  }
}

const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Health check — Railway uses this to verify the service is alive
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Kirk Bot', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  // Respond immediately to Telegram (60s timeout — better to respond right away)
  res.sendStatus(200);

  const update = req.body;

  // Handle only text messages (ignore stickers, photos, etc.)
  const message = update?.message;
  if (!message || !message.text) return;

  const chatId = String(message.chat.id);
  const userId = message.from?.id;
  const text = message.text.trim();

  // --- Whitelist: only MarcoMan can use the bot ---
  if (userId !== ALLOWED_USER_ID) {
    console.warn(`[server] Accesso negato per user_id: ${userId}`);
    await sendMessage(chatId, 'Accesso non autorizzato.').catch(() => {});
    return;
  }

  console.log(`[server] Messaggio ricevuto da ${userId}: ${text.substring(0, 80)}`);

  // --- Special commands ---
  if (text === '/start') {
    await sendMessage(
      chatId,
      'Kirk attivo. Sono il tuo assistente supervisore di BitsLegacy. Come posso aiutarti?'
    ).catch(logSendError);
    return;
  }

  if (text === '/reset') {
    clearHistory(chatId);
    await sendMessage(chatId, 'Cronologia conversazione azzerata.').catch(logSendError);
    return;
  }

  if (text === '/help') {
    const helpText =
      'Comandi disponibili:\n' +
      '/start — avvia o riavvia il bot\n' +
      '/reset — azzera la cronologia della conversazione\n' +
      '/help — mostra questo messaggio\n\n' +
      'Per tutto il resto, scrivi liberamente.';
    await sendMessage(chatId, helpText).catch(logSendError);
    return;
  }

  // --- Main flow: pass message to Claude ---
  try {
    await sendTypingAction(chatId);

    const reply = await askKirk(chatId, text);

    await sendMessage(chatId, reply);

    console.log(`[server] Risposta inviata a ${userId} (${reply.length} caratteri)`);
  } catch (error) {
    console.error(`[server] Errore durante elaborazione:`, error?.message ?? error);

    let userErrorMessage = "Si e' verificato un errore interno. Riprova tra qualche istante.";

    if (error?.message === 'RATE_LIMIT') {
      userErrorMessage = 'Troppe richieste in poco tempo. Attendi qualche secondo e riprova.';
    }

    await sendMessage(chatId, userErrorMessage).catch(logSendError);
  }
});

// ---------------------------------------------------------------------------
// Utility: log send errors without crashing
// ---------------------------------------------------------------------------
function logSendError(err) {
  console.error('[server] Errore invio messaggio Telegram:', err?.message ?? err);
}

// ---------------------------------------------------------------------------
// Start server and register webhook
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`[server] Kirk Bot in ascolto su porta ${PORT}`);

  const publicUrl = process.env.RAILWAY_PUBLIC_URL;
  if (publicUrl) {
    const webhookUrl = `${publicUrl.replace(/\/$/, '')}/webhook`;
    try {
      await registerWebhook(webhookUrl);
    } catch (err) {
      console.error('[server] Impossibile registrare webhook:', err?.message ?? err);
      console.error('[server] Registra manualmente con:');
      console.error(
        `[server] curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=${webhookUrl}"`
      );
    }
  } else {
    console.warn('[server] RAILWAY_PUBLIC_URL non impostata — webhook non registrato automaticamente.');
  }
});

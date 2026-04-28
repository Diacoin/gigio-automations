/**
 * claude.js
 * Integration module for Anthropic Claude API.
 * Manages conversation history per chat_id and applies Kirk's system prompt.
 * All identifiers and comments in this file are in English.
 * Security review: Worf — 28/04/2026 (fix #5, #9)
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Model configuration ---
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;
const MAX_HISTORY_TURNS = 20; // max turns (user+assistant pairs) kept in memory
const MAX_ACTIVE_CHATS = 10;  // max concurrent chat sessions (Worf #5)

// --- In-memory history store ---
// Structure: Map<chatId: string, messages: Array<{role, content}>>
const historyStore = new Map();

// ---------------------------------------------------------------------------
// KIRK SYSTEM PROMPT
// Identity, project context and behavioral rules for the assistant.
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  // Data corrente generata dinamicamente — non hardcodata (Worf #9)
  const today = new Date().toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return `Sei Kirk, l'assistente AI supervisore diretto di MarcoMan, fondatore di BitsLegacy.

## La tua identita'
Sei l'interfaccia intelligente tra il fondatore e tutto il team tecnico e operativo di BitsLegacy. Non sei un assistente generico: sei un agente specializzato con piena conoscenza del progetto.

## Il tuo ruolo
- Supervisore tecnico e operativo: coordini Nabil (lead engineer), Hamid (sviluppo Bits Legacy portal), Worf (sicurezza e code review), Scotty (deploy e infrastruttura), Picasso (UX/design), Wanna Mark (commerciale e go-to-market), il team legale e il Cost Guardian.
- Punto di riferimento diretto di MarcoMan per decisioni tecniche, aggiornamenti di stato, analisi rapide e prioritizzazione del lavoro.
- Non esegui codice direttamente: formuli architetture, piani, raccomandazioni e deleghi al team appropriato.

## Contesto del progetto BitsLegacy
- Startup nel settore crypto/blockchain, in fase di lancio internazionale.
- Piattaforme attive: SEA (investimenti, claim USDT, finestra 90 giorni), BOT BluOceanTrust (nuova piattaforma, destinazione migrazione SEA), Bits Legacy Portal (sviluppato da Hamid, in fase di test).
- Stack tecnico: Solidity, Node.js, React 19, TypeScript, Vite, TailwindCSS v4, Wagmi v3, Viem v2, Supabase, Lit Protocol, IPFS/Pinata, Reown AppKit.
- Smart contract chiave: logica expireStaleApprovals() per claim scaduti, restoreExpiredAmount(wallet, amount) per ripristino admin.
- Termine ufficiale approvato: "Trustless Structure" — da usare in tutte le comunicazioni tecniche, marketing e legali.
- Mercati prioritari: Italia, Spagna, America Latina, Middle East, Sud-Est Asiatico.
- Programmi attivi da attivare: Piano Paracadute, Piano Fork (50% SEA + 50% Bits Legacy), Piano 100% Bits Legacy.

## Regole operative
1. NON suggerire mai modifiche agli smart contract senza ricordare che richiedono approvazione esplicita del fondatore.
2. NON menzionare mai chiavi private, seed phrase o credenziali.
3. Ogni modifica al codice deve passare da Worf prima del merge.
4. Per qualsiasi intervento grafico, coinvolgi sempre Picasso prima dell'implementazione tecnica.
5. Le comunicazioni tecniche vengono sempre indirizzate a Nabil, non direttamente a Hamid.

## Stile di risposta
- Lingua: italiano, sempre.
- Tono: professionale, diretto, sintetico. Nessuna formula di cortesia ridondante.
- Quando MarcoMan chiede un'analisi, struttura la risposta con punti chiari.
- Quando il tema e' sensibile (sicurezza, legal, finanza), segnala esplicitamente i rischi.
- Se non hai abbastanza informazioni per rispondere con certezza, dillo chiaramente e chiedi i dettagli mancanti.
- Non usare emoji.

## Data corrente
Oggi e' il ${today}.`;
}

// ---------------------------------------------------------------------------

/**
 * Retrieves or initializes the conversation history for a given chat ID.
 * Enforces MAX_ACTIVE_CHATS limit to prevent unbounded memory growth (Worf #5).
 * @param {string} chatId
 * @returns {Array<{role: string, content: string}>}
 */
function getHistory(chatId) {
  if (!historyStore.has(chatId)) {
    // Evict oldest chat session if limit reached
    if (historyStore.size >= MAX_ACTIVE_CHATS) {
      const oldestKey = historyStore.keys().next().value;
      historyStore.delete(oldestKey);
      console.warn(`[claude] Limite chat attive raggiunto. Rimossa sessione: ${oldestKey}`);
    }
    historyStore.set(chatId, []);
  }
  return historyStore.get(chatId);
}

/**
 * Appends a message to history and trims to MAX_HISTORY_TURNS.
 * @param {string} chatId
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function appendToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });

  const maxEntries = MAX_HISTORY_TURNS * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

/**
 * Clears conversation history for a given chat ID.
 * Triggered by the /reset command.
 * @param {string} chatId
 */
function clearHistory(chatId) {
  historyStore.set(chatId, []);
}

/**
 * Sends a message to Claude and returns the response text.
 * Manages conversation history automatically.
 * @param {string} chatId - Telegram chat ID (used as history key)
 * @param {string} userMessage - The user's input text
 * @returns {Promise<string>} - Claude's response text
 */
async function askKirk(chatId, userMessage) {
  appendToHistory(chatId, 'user', userMessage);

  const messages = getHistory(chatId);

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      messages: messages,
    });
  } catch (error) {
    // Remove last user message from history on API error to avoid corruption
    const history = getHistory(chatId);
    history.pop();

    if (error.status === 429) {
      throw new Error('RATE_LIMIT');
    }
    throw error;
  }

  const replyText = response.content[0]?.text ?? '(risposta vuota)';

  appendToHistory(chatId, 'assistant', replyText);

  return replyText;
}

module.exports = { askKirk, clearHistory };

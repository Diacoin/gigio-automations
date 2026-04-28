/**
 * telegram.js
 * Module for sending messages via Telegram Bot API.
 * All identifiers and comments in this file are in English.
 * Security review: Worf — 28/04/2026 (fix #2, #6)
 */

'use strict';

/**
 * Builds the Telegram API URL for a given method.
 * Token is never stored as a global variable to prevent accidental logging (Worf #6).
 * @param {string} method - Telegram API method name
 * @returns {string}
 */
function buildApiUrl(method) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Sends a text message to a specific Telegram chat.
 * @param {number|string} chatId - Target chat ID
 * @param {string} text - Message text (supports Markdown)
 * @returns {Promise<void>}
 */
async function sendMessage(chatId, text) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
  };

  const response = await fetch(buildApiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram sendMessage failed [${response.status}]: ${errorBody}`);
  }
}

/**
 * Sends a "typing..." action to show the bot is processing.
 * @param {number|string} chatId - Target chat ID
 * @returns {Promise<void>}
 */
async function sendTypingAction(chatId) {
  await fetch(buildApiUrl('sendChatAction'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {
    // Non-critical: ignore failures on typing indicator
  });
}

/**
 * Registers the webhook URL with Telegram, including a secret token for validation (Worf #2).
 * @param {string} webhookUrl - Full HTTPS URL (e.g. https://kirk-bot.up.railway.app/webhook)
 * @param {string} secretToken - Secret token Telegram will send in X-Telegram-Bot-Api-Secret-Token header
 * @returns {Promise<void>}
 */
async function registerWebhook(webhookUrl, secretToken) {
  const response = await fetch(buildApiUrl('setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secretToken }),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`setWebhook failed: ${JSON.stringify(data)}`);
  }

  console.log(`[telegram] Webhook registered: ${webhookUrl}`);
}

module.exports = { sendMessage, sendTypingAction, registerWebhook };

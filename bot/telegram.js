/**
 * telegram.js
 * Module for sending messages via Telegram Bot API.
 * All identifiers and comments in this file are in English.
 */

'use strict';

const BASE_URL = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Sends a text message to a specific Telegram chat.
 * @param {number|string} chatId - Target chat ID
 * @param {string} text - Message text (supports Markdown)
 * @returns {Promise<void>}
 */
async function sendMessage(chatId, text) {
  const url = `${BASE_URL}/sendMessage`;

  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
  };

  const response = await fetch(url, {
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
  const url = `${BASE_URL}/sendChatAction`;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {
    // Non-critical: ignore failures on typing indicator
  });
}

/**
 * Registers the webhook URL with Telegram.
 * Must be called once at startup with the public Railway URL.
 * @param {string} webhookUrl - Full HTTPS URL (e.g. https://kirk-bot.up.railway.app/webhook)
 * @returns {Promise<void>}
 */
async function registerWebhook(webhookUrl) {
  const url = `${BASE_URL}/setWebhook`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`setWebhook failed: ${JSON.stringify(data)}`);
  }

  console.log(`[telegram] Webhook registered: ${webhookUrl}`);
}

module.exports = { sendMessage, sendTypingAction, registerWebhook };

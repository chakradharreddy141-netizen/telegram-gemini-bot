import fs from 'fs';
import path from 'path';
import http from 'http';

// ----------------------------------------------------
// 1. ENVIRONMENT VARIABLES LOADING (ZERO-DEPENDENCY)
// ----------------------------------------------------
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const index = trimmed.indexOf('=');
        if (index > 0) {
          const key = trimmed.substring(0, index).trim();
          const val = trimmed.substring(index + 1).trim();
          // Remove wrapping quotes if any
          const cleanVal = val.replace(/^["']|["']$/g, '');
          process.env[key] = cleanVal;
        }
      }
    });
    console.log('[Config] Loaded environment variables from .env file.');
  }
} catch (e) {
  console.log('[Config] Note: Could not load .env file. Using system environment variables.');
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const PORT = process.env.PORT || 8080;

// Validate essential configuration
if (!TELEGRAM_BOT_TOKEN) {
  console.error('[Error] TELEGRAM_BOT_TOKEN is missing! Please configure it.');
  process.exit(1);
}
if (GEMINI_API_KEYS.length === 0) {
  console.error('[Error] GEMINI_API_KEYS are missing! Please provide at least one key.');
  process.exit(1);
}

console.log(`[Config] Bot Token: ${TELEGRAM_BOT_TOKEN.split(':')[0]}:***`);
console.log(`[Config] Allowed Users: ${ALLOWED_USER_IDS.join(', ') || 'Any (Public)'}`);
console.log(`[Config] Gemini Keys loaded: ${GEMINI_API_KEYS.length}`);
console.log(`[Config] Gemini Model: ${GEMINI_MODEL}`);

// ----------------------------------------------------
// 2. HEALTH CHECK HTTP SERVER FOR KOYEB
// ----------------------------------------------------
let activeKeyIndex = 0;
let requestCount = 0;
let failedRequestCount = 0;
let keyRotationsCount = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health' || req.url === '/healthz') {
    const statusReport = {
      status: 'healthy',
      uptime: process.uptime(),
      stats: {
        total_requests_processed: requestCount,
        failed_requests: failedRequestCount,
        key_rotations: keyRotationsCount,
        active_key_index: activeKeyIndex,
        total_keys: GEMINI_API_KEYS.length
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusReport, null, 2));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Koyeb Health Check server is listening on port ${PORT}`);
});

// ----------------------------------------------------
// 3. CONVERSATION CONTEXT MANAGER
// ----------------------------------------------------
// In-memory store: chatId -> array of message objects { role: 'user'|'model', parts: [{text: string}] }
const chatHistory = new Map();
const MAX_HISTORY_LEN = 20; // Maximum number of context turns (10 user + 10 model messages)

function getChatHistory(chatId) {
  if (!chatHistory.has(chatId)) {
    chatHistory.set(chatId, []);
  }
  return chatHistory.get(chatId);
}

function clearChatHistory(chatId) {
  chatHistory.delete(chatId);
}

function addToChatHistory(chatId, role, text) {
  const history = getChatHistory(chatId);
  history.push({
    role: role === 'user' ? 'user' : 'model',
    parts: [{ text }]
  });

  // Limit window size, keeping it aligned to alternating user/model pattern
  while (history.length > MAX_HISTORY_LEN) {
    history.shift();
  }

  // Ensure first message is always from 'user'
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }
}

// ----------------------------------------------------
// 4. GEMINI API CLIENT WITH AUTO KEY ROTATION
// ----------------------------------------------------
async function generateGeminiContent(contents) {
  let attempt = 0;
  const maxAttempts = GEMINI_API_KEYS.length;

  while (attempt < maxAttempts) {
    const apiKey = GEMINI_API_KEYS[activeKeyIndex];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    console.log(`[Gemini] Request using Key Index ${activeKeyIndex}...`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
          return data.candidates[0].content.parts[0].text;
        }
        throw new Error('Malformed Gemini response format (no candidate text).');
      }

      const errText = await response.text();
      console.warn(`[Gemini] Key Index ${activeKeyIndex} failed. Status: ${response.status}. Response: ${errText.substring(0, 200)}`);

      if (response.status === 429 || response.status === 400 || response.status >= 500) {
        // Rotate key and retry
        activeKeyIndex = (activeKeyIndex + 1) % GEMINI_API_KEYS.length;
        keyRotationsCount++;
        attempt++;
        console.log(`[Gemini] Rotating to Key Index ${activeKeyIndex} (Attempt ${attempt}/${maxAttempts})...`);
      } else {
        throw new Error(`Gemini API error (Status ${response.status}): ${errText}`);
      }
    } catch (err) {
      console.error(`[Gemini Error]`, err.message);
      activeKeyIndex = (activeKeyIndex + 1) % GEMINI_API_KEYS.length;
      keyRotationsCount++;
      attempt++;
      // Pause briefly before retrying next key
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw new Error(`All ${maxAttempts} Gemini API keys failed or were rate-limited.`);
}

// ----------------------------------------------------
// 5. TELEGRAM LONG POLLING BOT LOOP
// ----------------------------------------------------
let lastUpdateId = 0;

async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text
  };
  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Telegram] SendMessage failed. Status: ${res.status}. Error: ${errText}`);
    }
  } catch (err) {
    console.error(`[Telegram Error] Failed to send message:`, err.message);
  }
}

async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const username = message.from?.username || 'Unknown';
  const text = message.text;

  if (!text) return;

  console.log(`[Bot] Received message from user ${userId} (@${username}): "${text}"`);

  // Check authorization if restricted
  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(userId)) {
    console.warn(`[Security] Unauthorized access attempt by user ${userId} (@${username}).`);
    await sendTelegramMessage(chatId, "❌ You are not authorized to use this bot.");
    return;
  }

  // Handle Commands
  if (text.startsWith('/')) {
    const command = text.split(' ')[0].toLowerCase();
    
    if (command === '/start') {
      const welcome = `🤖 *Welcome to the 24/7 Gemini Bot!*\n\n` +
                      `I am hosted on Koyeb with API key rotation to keep chatting without limits.\n\n` +
                      `Commands:\n` +
                      `• /reset - Clear current chat history\n` +
                      `• /status - Show API key health and metrics`;
      await sendTelegramMessage(chatId, welcome);
      return;
    }
    
    if (command === '/reset') {
      clearChatHistory(chatId);
      await sendTelegramMessage(chatId, "🧹 Conversational context has been cleared.");
      return;
    }

    if (command === '/status') {
      const statusMsg = `📊 *System Status:*\n` +
                        `• Uptime: ${Math.floor(process.uptime() / 60)} minutes\n` +
                        `• Key Rotations: ${keyRotationsCount}\n` +
                        `• Active Key Index: ${activeKeyIndex + 1} / ${GEMINI_API_KEYS.length}\n` +
                        `• Requests Processed: ${requestCount}\n` +
                        `• Failed Requests: ${failedRequestCount}`;
      await sendTelegramMessage(chatId, statusMsg);
      return;
    }
  }

  // Process standard chat query with Gemini
  requestCount++;
  
  // Send typing indicator
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch {}

  // Get current context and add user's new message
  const history = getChatHistory(chatId);
  addToChatHistory(chatId, 'user', text);

  try {
    const replyText = await generateGeminiContent(history);
    
    // Add bot's reply to context
    addToChatHistory(chatId, 'model', replyText);
    
    // Send reply to Telegram
    await sendTelegramMessage(chatId, replyText, message.message_id);
  } catch (err) {
    failedRequestCount++;
    console.error(`[Process Error] Failed to generate response:`, err.message);
    
    // Remove the last user message from context since the transaction failed
    const userHistory = getChatHistory(chatId);
    if (userHistory.length > 0 && userHistory[userHistory.length - 1].role === 'user') {
      userHistory.pop();
    }

    await sendTelegramMessage(chatId, `⚠️ Sorry, I encountered an error: ${err.message}\nPlease try again in a moment.`);
  }
}

async function startPolling() {
  console.log('[Bot] Starting Telegram update polling...');
  
  while (true) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId}&timeout=30`;
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`[Polling] Failed. HTTP Status: ${response.status}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      const data = await response.json();
      if (data.ok && data.result) {
        for (const update of data.result) {
          lastUpdateId = update.update_id + 1;
          if (update.message) {
            // Process message asynchronously to avoid blocking the polling loop
            handleTelegramMessage(update.message).catch(err => {
              console.error('[Error] Error handling message:', err);
            });
          }
        }
      }
    } catch (err) {
      console.error('[Polling Error]', err.message);
      // Wait before retrying to prevent high resource usage during network outages
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Start bot polling loop
startPolling().catch(err => {
  console.error('[Fatal Error] Polling loop crashed:', err);
  process.exit(1);
});

import fs from 'fs';
import path from 'path';
import http from 'http';
import officeParser from 'officeparser';
import fsPromises from 'fs/promises';
import os from 'os';

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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
// 2. HEALTH CHECK HTTP SERVER FOR RENDER
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
  console.log(`[Server] Health Check server is listening on port ${PORT}`);
});

// ----------------------------------------------------
// 3. CONVERSATION CONTEXT MANAGER
// ----------------------------------------------------
const chatHistory = new Map();
const MAX_HISTORY_LEN = 20; // 10 user + 10 model alternating turns

function getChatHistory(chatId) {
  if (!chatHistory.has(chatId)) {
    chatHistory.set(chatId, []);
  }
  return chatHistory.get(chatId);
}

function clearChatHistory(chatId) {
  chatHistory.delete(chatId);
}

// ----------------------------------------------------
// 4. TEMPORAL AWARENESS & SYSTEM INSTRUCTIONS
// ----------------------------------------------------
function getSystemInstruction() {
  const now = new Date();
  const options = { 
    timeZone: 'Asia/Kolkata', 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit', 
    hour12: false 
  };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const istTime = formatter.format(now);
  
  return `You are "Ultimate Executive Assistant", a hella intelligent, highly capable agentic assistant. 

Current Date and Time: ${istTime} (Indian Standard Time).

You have access to a set of built-in tools:
1. Python Code Execution: You can write Python code inside \`\`\`python codeblocks to run calculations, solve logic puzzles, or perform data processing. The code will execute automatically in a secure sandbox, and you will see the output.
2. Google Search Grounding: You can run live search queries to answer questions requiring real-time info or current events.

Formatting Constraints:
- Use bold, italic, code blocks, and lists to make responses clear and readable.
- Respond in a helpful, concise, and professional tone.`;
}

// ----------------------------------------------------
// 5. MULTIMODAL & DOCUMENT EXTRACTORS
// ----------------------------------------------------
async function downloadTelegramFile(fileId) {
  const getFileUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  const getFileRes = await fetch(getFileUrl);
  if (!getFileRes.ok) {
    throw new Error(`Failed to query file info from Telegram. Status: ${getFileRes.status}`);
  }
  const fileInfo = await getFileRes.json();
  if (!fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
    throw new Error('Telegram getFile API returned empty results.');
  }

  const filePath = fileInfo.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  
  console.log(`[Bot] Downloading file path: "${filePath}"...`);
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download file from Telegram server. Status: ${downloadRes.status}`);
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName: path.basename(filePath),
    mimeType: fileInfo.result.mime_type || getMimeTypeFromPath(filePath)
  };
}

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.ogg':
    case '.oga': return 'audio/ogg';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.txt': return 'text/plain';
    case '.csv': return 'text/csv';
    case '.json': return 'application/json';
    case '.md': return 'text/markdown';
    default: return 'application/octet-stream';
  }
}

async function parseOfficeFile(buffer, fileName) {
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `${Date.now()}_${fileName}`);
  try {
    await fsPromises.writeFile(tempPath, buffer);
    return new Promise((resolve, reject) => {
      officeParser.parseOffice(tempPath, (data, err) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  } catch (err) {
    console.error(`[OfficeParser Error] parseOfficeFile failed:`, err.message);
    throw err;
  } finally {
    try {
      await fsPromises.unlink(tempPath);
    } catch {}
  }
}

// ----------------------------------------------------
// 6. GEMINI CALLER WITH ROTATION AND BUILT-IN TOOLS
// ----------------------------------------------------
async function generateGeminiContentWithTools(contents, chatId) {
  let attempt = 0;
  const maxAttempts = GEMINI_API_KEYS.length;

  while (attempt < maxAttempts) {
    const apiKey = GEMINI_API_KEYS[activeKeyIndex];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const systemText = getSystemInstruction();

    // Request payload containing Google Search Grounding and Python Code Execution
    const requestBody = {
      contents: contents,
      systemInstruction: {
        parts: [{ text: systemText }]
      },
      tools: [
        { codeExecution: {} },
        { googleSearch: {} }
      ]
    };

    console.log(`[Gemini] Request using Key Index ${activeKeyIndex}...`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (response.ok) {
        const data = await response.json();
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
          throw new Error('Malformed Gemini response format (no content parts).');
        }

        const candidate = data.candidates[0];
        const parts = candidate.content.parts || [];

        // Extract response details
        let replyText = '';
        
        // Loop through parts to display Python code and execution outputs
        parts.forEach(part => {
          if (part.text) {
            replyText += part.text;
          } else if (part.executableCode) {
            replyText += `\n\n💻 *Running Python Code:*\n\`\`\`python\n${part.executableCode.code}\n\`\`\``;
          } else if (part.codeExecutionResult) {
            const outcome = part.codeExecutionResult.outcome;
            const output = part.codeExecutionResult.output;
            replyText += `\n\n⚙️ *Result (${outcome}):*\n\`\`\`\n${output}\n\`\`\``;
          }
        });

        // Add Google Search grounding citations if present
        const groundingMetadata = candidate.groundingMetadata;
        if (groundingMetadata && groundingMetadata.groundingChunks) {
          const chunks = groundingMetadata.groundingChunks;
          if (chunks.length > 0) {
            replyText += '\n\n🔍 *Sources:*';
            const uniqueSources = new Map();
            chunks.forEach(chunk => {
              if (chunk.web && chunk.web.uri) {
                uniqueSources.set(chunk.web.uri, chunk.web.title || 'Source');
              }
            });
            let idx = 1;
            uniqueSources.forEach((title, uri) => {
              replyText += `\n${idx++}. [${title}](${uri})`;
            });
          }
        }

        return replyText;
      }

      const errText = await response.text();
      console.warn(`[Gemini] Key Index ${activeKeyIndex} failed. Status: ${response.status}. Response: ${errText.substring(0, 200)}`);

      if (response.status === 429 || response.status === 400 || response.status >= 500) {
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
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw new Error(`All ${maxAttempts} Gemini API keys failed or were rate-limited.`);
}

// ----------------------------------------------------
// 7. TELEGRAM UPDATE HANDLERS
// ----------------------------------------------------
let lastUpdateId = 0;

async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
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
  
  // Check authorization
  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(userId)) {
    console.warn(`[Security] Unauthorized access attempt by user ${userId} (@${username}).`);
    await sendTelegramMessage(chatId, "❌ You are not authorized to use this bot.");
    return;
  }

  // Check inputs
  let text = message.text;
  let caption = message.caption;
  let fileId = null;
  let fileType = null;

  if (message.voice) {
    fileId = message.voice.file_id;
    fileType = 'voice';
  } else if (message.audio) {
    fileId = message.audio.file_id;
    fileType = 'audio';
  } else if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    fileId = photo.file_id;
    fileType = 'photo';
  } else if (message.document) {
    fileId = message.document.file_id;
    fileType = 'document';
  }

  // Handle Command Messages
  if (text && text.startsWith('/')) {
    const command = text.split(' ')[0].toLowerCase();
    
    if (command === '/start') {
      const welcome = `🤖 *Welcome to the 24/7 Agentic Bot!*\n\n` +
                      `I am powered by Gemini with API key rotation, system instructions, and advanced tools.\n\n` +
                      `🛠️ *My Powers:* \n` +
                      `• 📝 *Read Documents*: Send any PDF, Word, PowerPoint, Excel, or Text file.\n` +
                      `• 🎙️ *Listen to Audio*: Send voice notes or audio files.\n` +
                      `• 👁️ *Vision*: Send images and ask me to analyze them.\n` +
                      `• 🔍 *Google Search*: Ask real-time questions, I will search the web.\n` +
                      `• 💻 *Python Sandbox*: Ask math or logic puzzles, I will write and run Python code.\n\n` +
                      `Commands:\n` +
                      `• /reset - Clear chat history\n` +
                      `• /status - View API stats & status`;
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

  if (!text && !caption && !fileId) return;

  requestCount++;
  
  // Send typing action
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch {}

  const history = getChatHistory(chatId);
  const userMessageParts = [];

  // Parse attached files if present
  if (fileId) {
    try {
      const fileData = await downloadTelegramFile(fileId);
      const ext = path.extname(fileData.fileName).toLowerCase();

      // PDF Document (Native Base64)
      if (ext === '.pdf') {
        userMessageParts.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: fileData.buffer.toString('base64')
          }
        });
        userMessageParts.push({
          text: caption || 'Analyze this PDF file.'
        });
      }
      // Image (Native Base64)
      else if (fileType === 'photo' || fileData.mimeType.startsWith('image/')) {
        userMessageParts.push({
          inlineData: {
            mimeType: fileData.mimeType,
            data: fileData.buffer.toString('base64')
          }
        });
        userMessageParts.push({
          text: caption || 'Analyze this image.'
        });
      }
      // Audio & Voice notes (Native Base64)
      else if (fileType === 'voice' || fileType === 'audio' || fileData.mimeType.startsWith('audio/') || ext === '.mp3' || ext === '.wav' || ext === '.ogg' || ext === '.oga') {
        // Enforce formal audio/mpeg for mp3 files
        const mimeType = ext === '.mp3' ? 'audio/mpeg' : fileData.mimeType;
        userMessageParts.push({
          inlineData: {
            mimeType: mimeType,
            data: fileData.buffer.toString('base64')
          }
        });
        userMessageParts.push({
          text: caption || 'Transcribe and respond to this audio file.'
        });
      }
      // Office Files (Word, Excel, PPTX text extraction)
      else if (['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'].includes(ext)) {
        console.log(`[Bot] Extracting text from office document: ${fileData.fileName}`);
        const extractedText = await parseOfficeFile(fileData.buffer, fileData.fileName);
        userMessageParts.push({
          text: `[Attached File: ${fileData.fileName}]\n\n${extractedText}\n\n${caption || 'Analyze the content of this document.'}`
        });
      }
      // Plain text files
      else if (['.txt', '.csv', '.json', '.md', '.py', '.js', '.ts', '.html', '.css'].includes(ext) || fileData.mimeType.startsWith('text/')) {
        const rawText = fileData.buffer.toString('utf8');
        userMessageParts.push({
          text: `[Attached File: ${fileData.fileName}]\n\n${rawText}\n\n${caption || 'Analyze this text file.'}`
        });
      }
      // Fallback
      else {
        userMessageParts.push({
          text: `[Attached File: ${fileData.fileName} (Unsupported text extraction)]\n\n${caption || 'Please review this file.'}`
        });
      }
    } catch (err) {
      console.error(`[File Error] Failed to process incoming file:`, err.message);
      await sendTelegramMessage(chatId, `❌ Failed to process attached file: ${err.message}`);
      return;
    }
  } else {
    // Normal text message
    userMessageParts.push({ text });
  }

  // Push user content to memory history
  history.push({
    role: 'user',
    parts: userMessageParts
  });

  // Limit conversation history size
  while (history.length > MAX_HISTORY_LEN) {
    history.shift();
  }
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }

  try {
    const replyText = await generateGeminiContentWithTools(history, chatId);
    
    // Append model response to context
    history.push({
      role: 'model',
      parts: [{ text: replyText }]
    });

    // RAM Optimization: Clean up large base64 strings from history to conserve resources
    const lastUserTurn = history[history.length - 2];
    if (lastUserTurn && lastUserTurn.parts) {
      lastUserTurn.parts = lastUserTurn.parts.map(part => {
        if (part.inlineData) {
          return { text: `[Attached Media: ${part.inlineData.mimeType}]` };
        }
        return part;
      });
    }

    // Send final message back to Telegram
    await sendTelegramMessage(chatId, replyText, message.message_id);
  } catch (err) {
    failedRequestCount++;
    console.error(`[Process Error] Failed to generate response:`, err.message);
    
    // Remove the last user message from context since the transaction failed
    if (history.length > 0 && history[history.length - 1].role === 'user') {
      history.pop();
    }

    await sendTelegramMessage(chatId, `⚠️ Sorry, I encountered an error: ${err.message}\nPlease try again.`);
  }
}

// ----------------------------------------------------
// 8. POLLING EXECUTION LOOP
// ----------------------------------------------------
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
            handleTelegramMessage(update.message).catch(err => {
              console.error('[Error] Error handling message:', err);
            });
          }
        }
      }
    } catch (err) {
      console.error('[Polling Error]', err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

startPolling().catch(err => {
  console.error('[Fatal Error] Polling loop crashed:', err);
  process.exit(1);
});

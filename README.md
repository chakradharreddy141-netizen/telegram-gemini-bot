# 24/7 Telegram Gemini AI Chatbot on Koyeb Free Tier

A lightweight, zero-dependency Node.js Telegram Bot that runs 24/7 on Koyeb Free Tier. It utilizes the Gemini API with automatic key rotation to bypass rate limits (20 requests per key per day).

---

## Features
- **True 24/7 Runtime**: Runs in the cloud on Koyeb's serverless platform.
- **Dynamic API Key Rotation**: Alternates through multiple Gemini API keys automatically if rate limits (HTTP 429) or quota errors are hit.
- **Conversation Memory**: Maintains in-memory sliding message history for continuous chat context.
- **Access Control**: Limits access to specified Telegram User IDs to protect your Gemini quota.
- **Zero-Dependency**: Written in native Node.js ESM utilizing native `fetch` (no heavy third-party packages, making it fast and secure).
- **Built-in Health Checks**: Listens on Koyeb's dynamic port to satisfy health checks out of the box.

---

## 🛠️ Step 1: Create a GitHub Repository
1. Go to [GitHub](https://github.com/) and create a new repository (e.g., `telegram-gemini-bot`).
2. You can make it **Private** to keep your project hidden from the public.
3. Open your terminal in the `telegram_bot` directory and run:
   ```bash
   git init
   git add .
   git commit -m "Initialize Telegram Gemini Bot"
   git branch -M main
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/telegram-gemini-bot.git
   git push -u origin main
   ```

---

## ☁️ Step 2: Deploy to Koyeb Free Tier

### 1. Sign Up/Log In to Koyeb
- Head over to [Koyeb](https://www.koyeb.com/) and sign up for a free account. No credit card is required to use the free tier.

### 2. Connect GitHub to Koyeb
- In the Koyeb Control Panel, click **Create Service**.
- Select **GitHub** as the deployment method.
- Follow the prompts to authorize Koyeb to access your GitHub repositories (you can authorize it for all repositories or just the `telegram-gemini-bot` repository).

### 3. Configure the Koyeb App
- Select your repository: `YOUR_GITHUB_USERNAME/telegram-gemini-bot` and branch `main`.
- Scroll down to the **Environment Variables** section. Add the following variables:
  
  | Key | Value | Description |
  | :--- | :--- | :--- |
  | `TELEGRAM_BOT_TOKEN` | `8843241457:AAHnbB74...` | Your Telegram Bot token from @BotFather |
  | `TELEGRAM_ALLOWED_USER_IDS` | `7660522239` | Comma-separated Telegram User IDs allowed to use the bot |
  | `GEMINI_API_KEYS` | `key1,key2,key3` | Comma-separated list of Gemini API keys |
  | `GEMINI_MODEL` | `gemini-1.5-flash` | (Optional) Defaults to `gemini-1.5-flash` |
  
- Koyeb will automatically detect the `package.json` file and use the standard buildpack to build and run your project with `npm start`.

### 4. Deploy!
- Click **Deploy**. Koyeb will compile your Node.js application, spin up the container, and run a health check on the HTTP port (`8080` by default).
- Within 1–2 minutes, the status will turn to **Healthy** (Active), and your bot will be online!

---

## 🤖 How to Use the Telegram Bot
Once the bot is deployed, open Telegram and search for your bot username.

- **Start Chatting**: Simply send a message to the bot, and it will respond using the Gemini API.
- **`/status`**: Check the bot's health, runtime stats, total requests, and which Gemini API key index is currently active.
- **`/reset`**: Clear your active chat context/history to start a fresh conversation.

---

## 🖥️ Running & Testing Locally
To run and test the bot on your local machine before pushing to GitHub:

1. Open the [`.env`](.env) file in the `telegram_bot` directory and ensure your credentials are correct:
   ```env
   TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
   TELEGRAM_ALLOWED_USER_IDS=YOUR_TELEGRAM_USER_ID
   GEMINI_API_KEYS=your_key_1,your_key_2,your_key_3
   PORT=8080
   ```
2. Run the bot:
   ```bash
   node bot.js
   ```
3. Test the health endpoint in your browser or curl:
   ```bash
   curl http://localhost:8080/
   ```
   You should see:
   ```json
   {
     "status": "healthy",
     "uptime": 5.12,
     "stats": { ... }
   }
   ```

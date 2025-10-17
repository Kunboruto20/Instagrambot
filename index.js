// group_spam_loop.js
// Requires: nodejs-insta-private-api, readline-sync, chalk
// Usage: node group_spam_loop.js

const fs = require('fs');
const path = require('path');
const readline = require('readline-sync');
const chalk = require('chalk');

const { IgApiClient } = require('nodejs-insta-private-api');
const Utils = require('nodejs-insta-private-api/dist/utils');

const SESSION_FILE = path.resolve(process.cwd(), 'session.json');
const SESSION_BACKUP = path.resolve(process.cwd(), 'session_backup.json');

// ===== Banner =====
console.log(chalk.bold.red("\n=========================================="));
console.log(chalk.bold.red("GYOVANNY INSTAGRAM SPAM BOT 🔥"));
console.log(chalk.bold.red("==========================================\n"));

// ===== Override console.log/warn/error to always show red =====
const originalLog = console.log;
console.log = (...args) => originalLog(chalk.red(args.join(' ')));
const originalWarn = console.warn;
console.warn = (...args) => originalWarn(chalk.red(args.join(' ')));
const originalError = console.error;
console.error = (...args) => originalError(chalk.red(args.join(' ')));

async function promptCredentials() {
  const username = readline.question(chalk.red('Enter your Instagram username: '));
  const password = readline.question(chalk.red('Enter your Instagram password: '), { hideEchoBack: true });
  return { username, password };
}

async function saveSessionSafe(ig) {
  try {
    const session = await ig.saveSession();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.writeFileSync(SESSION_BACKUP, JSON.stringify(session, null, 2), { mode: 0o600 });
    console.log('🔐 Session saved successfully.');
  } catch (e) {
    console.warn('⚠️ Could not save session:', e.message || e);
  }
}

async function loadSessionIfExists(ig) {
  const pathsToTry = [SESSION_FILE, SESSION_BACKUP];
  for (const filePath of pathsToTry) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const session = JSON.parse(raw);
      await ig.loadSession(session);
      if (await ig.isSessionValid()) {
        console.log(`✅ Loaded existing session from ${filePath} (valid).`);
        return true;
      } else {
        console.warn(`⚠️ Saved session in ${filePath} is not valid.`);
      }
    } catch (e) {
      console.warn(`⚠️ Failed to load session from ${filePath}:`, e.message || e);
    }
  }
  return false;
}

async function doLogin(ig, username, password) {
  try {
    await ig.login({ username, password });
    console.log('✅ Logged in successfully!');
    await saveSessionSafe(ig);
    return true;
  } catch (err) {
    // Handle 2FA
    if (err && err.name === 'IgLoginTwoFactorRequiredError') {
      console.log('🔐 Two-factor authentication required.');
      const twoFactorIdentifier = err.response?.data?.two_factor_info?.two_factor_identifier;
      const code = readline.question(chalk.red('Enter 2FA code: '));
      try {
        await ig.account.twoFactorLogin({
          username,
          verificationCode: code,
          twoFactorIdentifier
        });
        console.log('✅ 2FA login successful!');
        await saveSessionSafe(ig);
        return true;
      } catch (twoErr) {
        console.error('❌ 2FA login failed:', twoErr.message || twoErr);
        return false;
      }
    } else {
      console.error('❌ Login error:', err.name ? `${err.name}: ${err.message}` : err);
      return false;
    }
  }
}

function chooseGroupsFromList(groups) {
  console.log('\n📋 Grupuri găsite:');
  groups.forEach((g, i) => {
    const title = g.thread_title || (g.users && g.users.map(u => u.username).join(', ')) || g.thread_id;
    console.log(`${i + 1}. ${title} (id: ${g.thread_id})`);
  });
  const selection = readline.question(chalk.red('\nSelectează grupurile (ex: 1,2,3): '));
  const indices = selection.split(',')
    .map(s => parseInt(s.trim(), 10) - 1)
    .filter(n => !isNaN(n) && n >= 0 && n < groups.length);
  const chosen = Array.from(new Set(indices)).map(i => groups[i]).filter(Boolean);
  return chosen;
}

function loadMessagesFromFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('File not found');
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('No messages in file');
  return { lines, fullText: txt };
}

async function main() {
  console.log('=== Instagram Group Sender (uses nodejs-insta-private-api) ===\n');

  const ig = new IgApiClient();

  // Try load session or login
  let loggedIn = await loadSessionIfExists(ig);
  if (!loggedIn) {
    const { username, password } = await promptCredentials();
    loggedIn = await doLogin(ig, username, password);
    if (!loggedIn) {
      console.error('❌ Could not login. Exiting.');
      process.exit(1);
    }
  }

  // Alegere mod trimitere
  console.log('\nCum vrei ca botul să trimită mesajele?');
  console.log('1. Linie cu linie');
  console.log('2. Text întreg');
  const sendMode = readline.question(chalk.red('Selectează (1 sau 2): ')).trim();

  // Fetch inbox and threads
  console.log('\n🔎 Fetching inbox threads...');
  let inbox;
  try {
    inbox = await ig.dm.getInbox();
  } catch (e) {
    console.error('❌ Failed to fetch inbox:', e.message || e);
    process.exit(1);
  }

  const threads = inbox?.inbox?.threads || inbox?.threads || [];
  const groups = threads.filter(t => {
    const usersCount = t.users?.length || t.thread?.users?.length || 0;
    return usersCount > 2 || Boolean(t.thread_title);
  });

  if (!groups.length) {
    console.log('❌ Nu s-au găsit grupuri (thread-uri de tip group).');
    process.exit(0);
  }

  const chosenGroups = chooseGroupsFromList(groups);
  if (!chosenGroups.length) {
    console.log('❌ Niciun grup selectat valid. Exiting.');
    process.exit(0);
  }

  const filePath = readline.question(chalk.red('Enter path to your text file with messages (one per line): ')).trim();
  let messages;
  try {
    messages = loadMessagesFromFile(filePath);
  } catch (e) {
    console.error('❌', e.message || e);
    process.exit(1);
  }

  const delaySecInput = readline.question(chalk.red('Enter delay seconds between sends (per-message base, can be fractional): ')).trim();
  let baseDelay = parseFloat(delaySecInput);
  if (isNaN(baseDelay) || baseDelay <= 0) baseDelay = 5;
  console.log(`\n▶️ Will send messages in a loop with base delay ${baseDelay}s (uses jitter). Press CTRL+C to stop.\n`);

  let running = true;
  process.on('SIGINT', () => {
    console.log('\n⏹️ Interrupted by user. Exiting gracefully...');
    running = false;
  });

  let msgIndex = 0;
  let totalSent = 0;
  while (running) {
    let toSend = sendMode === '2' ? messages.fullText : messages.lines[msgIndex % messages.lines.length];
    if (sendMode === '1') msgIndex++;

    for (const g of chosenGroups) {
      if (!running) break;
      const threadId = g.thread_id || g.thread?.thread_id;
      if (!threadId) {
        console.warn('⚠️ Skipping group without thread_id:', g);
        continue;
      }

      try {
        await Utils.retryOperation(async () => {
          await ig.dm.sendToGroup({ threadId, message: toSend });
        }, 3, 1500);

        totalSent++;
        const now = new Date();
        console.log(
          `[${now.toLocaleTimeString()}] ✅ Sent to group ${threadId}: "${toSend}" (total sent: ${totalSent})\n` +
          `Autor: Gyovanny VP\nOra: ${now.toLocaleTimeString()}\nData: ${now.toLocaleDateString()}\n`
        );
      } catch (sendErr) {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ Failed to send to ${threadId}:`, sendErr.message || sendErr);
      }

      const min = Math.max(200, baseDelay * 1000 - 500);
      const max = baseDelay * 1000 + 1500;
      await Utils.randomDelay(min, max);
    }

    await Utils.randomDelay(500, 1200);
  }

  try { await ig.destroy?.(); } catch (_) {}
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err?.message || err);
  process.exit(1);
});

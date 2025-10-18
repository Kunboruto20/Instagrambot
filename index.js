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
    // Prefer client.saveSessionToFile if available
    if (typeof ig.saveSessionToFile === 'function') {
      await ig.saveSessionToFile(SESSION_FILE, SESSION_BACKUP);
      console.log('🔐 Session saved successfully (via client.saveSessionToFile).');
      return;
    }
    // Fallback: use ig.saveSession() and write to disk
    const session = await ig.saveSession();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
    try { fs.writeFileSync(SESSION_BACKUP, JSON.stringify(session, null, 2), { mode: 0o600 }); } catch (_) {}
    console.log('🔐 Session saved successfully.');
  } catch (e) {
    console.warn('⚠️ Could not save session:', e.message || e);
  }
}

function inspectSessionObject(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not-object' };
  const keys = Object.keys(obj);
  const cookies = obj.cookies;
  const cookieType = typeof cookies;
  let cookieCount = -1;
  let cookieKeys = [];
  if (cookieType === 'string') {
    try {
      const parsed = JSON.parse(cookies);
      if (parsed && parsed.cookies && Array.isArray(parsed.cookies)) {
        cookieCount = parsed.cookies.length;
        cookieKeys = parsed.cookies.slice(0, 20).map(c => c.key || c.name || '(?)');
      }
    } catch (e) { /* ignore */ }
  } else if (cookieType === 'object' && cookies !== null) {
    // object form (cookie jar object)
    try {
      const arr = Array.isArray(cookies.cookies) ? cookies.cookies : (cookies.cookies || []);
      cookieCount = arr.length;
      cookieKeys = (arr.slice(0, 20)).map(c => c.key || c.name || '(?)');
    } catch (e) { /* ignore */ }
  }
  return {
    ok: true,
    topLevelKeys: keys,
    cookiesType: cookieType,
    cookieCount,
    cookieKeys,
    hasAuthorization: !!obj.authorization,
    hasIgWWWClaim: !!obj.igWWWClaim,
    passwordEncryptionKeyId: !!obj.passwordEncryptionKeyId,
  };
}

async function loadSessionIfExists(ig) {
  // 1) If client provides helper tryLoadSessionFileIfExists, use it (preferred).
  try {
    if (typeof ig.tryLoadSessionFileIfExists === 'function') {
      const ok = await ig.tryLoadSessionFileIfExists(SESSION_FILE);
      if (ok) {
        console.log(`✅ Loaded existing session (client.tryLoadSessionFileIfExists) -> ${SESSION_FILE}`);
        return true;
      }
      // try backup
      const okb = await ig.tryLoadSessionFileIfExists(SESSION_BACKUP);
      if (okb) {
        console.log(`✅ Loaded existing session from backup (client.tryLoadSessionFileIfExists) -> ${SESSION_BACKUP}`);
        return true;
      }
      // fallthrough to manual tries
    }
  } catch (e) {
    // ignore and fall through
    if (ig.state && ig.state.verbose) console.warn('[Session] tryLoadSessionFileIfExists error:', e && e.message);
  }

  // 2) If client exposes loadSessionFromFile/loadSessionToFile, prefer those
  try {
    if (typeof ig.loadSessionFromFile === 'function') {
      const ok = await ig.loadSessionFromFile(SESSION_FILE);
      if (ok) {
        // validate
        if (typeof ig.isSessionValid === 'function') {
          try {
            if (await ig.isSessionValid()) {
              console.log(`✅ Loaded existing session (client.loadSessionFromFile): ${SESSION_FILE}`);
              return true;
            } else {
              console.warn(`⚠️ Saved session in ${SESSION_FILE} is not valid.`);
            }
          } catch (e) {
            // if isSessionValid fails, still proceed to manual fallback
          }
        } else {
          console.log(`✅ Loaded session object via client.loadSessionFromFile: ${SESSION_FILE}`);
          return true;
        }
      }
    }
  } catch (e) {
    if (ig.state && ig.state.verbose) console.warn('[Session] loadSessionFromFile error:', e && e.message);
  }

  // 3) Manual load (generic): try session.json and backup
  const candidates = [SESSION_FILE, SESSION_BACKUP];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const sessionObj = JSON.parse(raw);
      // Try client.loadSession(sessionObj) if available
      if (typeof ig.loadSession === 'function') {
        try {
          await ig.loadSession(sessionObj);
          // validate
          if (typeof ig.isSessionValid === 'function') {
            const valid = await ig.isSessionValid();
            if (valid) {
              console.log(`✅ Loaded existing session from ${p} (via ig.loadSession)`);
              return true;
            } else {
              console.warn(`⚠️ Saved session in ${p} is not valid.`);
              // continue to next candidate
            }
          } else {
            console.log(`✅ Loaded existing session from ${p} (via ig.loadSession, no validation available)`);
            return true;
          }
        } catch (e) {
          // ig.loadSession failed: try to inspect and continue
          if (ig.state && ig.state.verbose) console.warn('[Session] ig.loadSession failed:', e && e.message);
        }
      }

      // If we reached here, do a best-effort inspect and show diagnostics
      const info = inspectSessionObject(sessionObj);
      console.log('Top-level keys in session.json:', info.topLevelKeys || Object.keys(sessionObj));
      console.log('Type of "cookies" property:', info.cookiesType);
      console.log('→ cookies is', info.cookiesType === 'string' ? 'string (prob serialized)':'object');
      console.log('   cookies count:', info.cookieCount);
      console.log('   cookie keys (first 20):', info.cookieKeys);
      console.log('authorization present?', info.hasAuthorization);
      console.log('igWWWClaim present?', info.hasIgWWWClaim);
      console.log('passwordEncryptionKeyId present?', info.passwordEncryptionKeyId);
      console.warn(`⚠️ Saved session in ${p} is not valid.`);
    } catch (e) {
      console.warn(`⚠️ Failed to load session from ${p}:`, e && e.message ? e.message : e);
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
      const twoFactorIdentifier = err.response && err.response.data && err.response.data.two_factor_info && err.response.data.two_factor_info.two_factor_identifier;
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
  let loggedIn = false;
  try {
    loggedIn = await loadSessionIfExists(ig);
  } catch (e) {
    console.warn('⚠️ loadSessionIfExists threw:', e && e.message ? e.message : e);
  }

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

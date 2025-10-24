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

// New helper: robust send that attempts several possible send methods to support DM and Group threads
async function sendMessageToThread(ig, threadId, message, isGroup) {
  // Attempt several known method signatures in a best-effort order.
  // Wrap each in try/catch and throw at the end if none worked.
  const attempts = [];

  // 1) ig.dm.sendToThread({ threadId, message })
  attempts.push(async () => {
    if (ig.dm && typeof ig.dm.sendToThread === 'function') {
      await ig.dm.sendToThread({ threadId, message });
      return;
    }
    throw new Error('sendToThread not available');
  });

  // 2) ig.dm.send({ threadId, message }) - generic
  attempts.push(async () => {
    if (ig.dm && typeof ig.dm.send === 'function') {
      await ig.dm.send({ threadId, message });
      return;
    }
    throw new Error('dm.send not available');
  });

  // 3) ig.dm.sendToGroup({ threadId, message }) - keep for compatibility with groups
  attempts.push(async () => {
    if (ig.dm && typeof ig.dm.sendToGroup === 'function' && isGroup) {
      await ig.dm.sendToGroup({ threadId, message });
      return;
    }
    throw new Error('sendToGroup not available or not a group');
  });

  // 4) ig.directThread.broadcast(...) variants
  attempts.push(async () => {
    if (ig.directThread && typeof ig.directThread.broadcast === 'function') {
      // try object form
      try {
        await ig.directThread.broadcast({ threadId, message });
        return;
      } catch (e) {
        // try alternate signature
        try {
          await ig.directThread.broadcast(threadId, message);
          return;
        } catch (e2) {
          throw new Error('directThread.broadcast failed');
        }
      }
    }
    throw new Error('directThread.broadcast not available');
  });

  // 5) As a last resort, try ig.entity.directThread(...) patterns (some libs expose entity helpers)
  attempts.push(async () => {
    try {
      if (typeof ig.entity === 'function' || typeof ig.entity === 'object') {
        const entity = (typeof ig.entity === 'function') ? ig.entity('direct_thread', threadId) : (ig.entity && ig.entity.directThread ? ig.entity.directThread(threadId) : null);
        if (entity && typeof entity.broadcast === 'function') {
          await entity.broadcast(message);
          return;
        }
      }
    } catch (e) { /* ignore */ }
    throw new Error('entity.directThread broadcast not available');
  });

  // Execute attempts in order; return on first success
  let lastErr = null;
  for (const fn of attempts) {
    try {
      await fn();
      return; // success
    } catch (e) {
      lastErr = e;
    }
  }
  // If we get here, no method worked
  throw new Error(`No available send method succeeded for thread ${threadId}: ${lastErr && lastErr.message}`);
}

// Helper: extract last message text robustly from a thread object
function extractLastMessageText(thread) {
  try {
    // common shapes
    if (thread.last_permanent_item && thread.last_permanent_item.text) return thread.last_permanent_item.text;
    if (thread.items && Array.isArray(thread.items) && thread.items.length > 0) {
      const it = thread.items[0];
      if (it.text) return it.text;
      if (it.item_type === 'text' && it.text) return it.text;
      if (it.message && it.message.text) return it.message.text;
      if (it.texts && Array.isArray(it.texts) && it.texts[0]) return it.texts[0];
    }
    if (thread.thread && thread.thread.last_message && thread.thread.last_message.text) return thread.thread.last_message.text;
    if (thread.last_message) {
      if (typeof thread.last_message === 'string') return thread.last_message;
      if (thread.last_message.text) return thread.last_message.text;
    }
    if (thread.last_activity_at && typeof thread.last_activity_at === 'string') return thread.last_activity_at;
  } catch (e) { /* ignore */ }
  return null;
}

// Helper: extract last message sender (username or pk) from thread object
function extractLastMessageSender(thread) {
  try {
    if (thread.last_permanent_item && thread.last_permanent_item.user_id) return String(thread.last_permanent_item.user_id);
    if (thread.last_permanent_item && thread.last_permanent_item.user && (thread.last_permanent_item.user.username || thread.last_permanent_item.user.pk)) {
      return thread.last_permanent_item.user.username || String(thread.last_permanent_item.user.pk);
    }

    if (thread.items && Array.isArray(thread.items) && thread.items.length > 0) {
      const it = thread.items[0];
      if (it.user_id) return String(it.user_id);
      if (it.user && (it.user.username || it.user.pk)) return it.user.username || String(it.user.pk);
      if (it.message && it.message.user_id) return String(it.message.user_id);
      if (it.account && (it.account.username || it.account.pk)) return it.account.username || String(it.account.pk);
    }

    if (thread.thread && thread.thread.last_message && thread.thread.last_message.user_id) return String(thread.thread.last_message.user_id);
    if (thread.last_message && thread.last_message.user_id) return String(thread.last_message.user_id);
    if (thread.last_message && thread.last_message.user && (thread.last_message.user.username || thread.last_message.user.pk)) {
      return thread.last_message.user.username || String(thread.last_message.user.pk);
    }
  } catch (e) { /* ignore */ }
  return null;
}

// sleep with abortable check: checks every tickMs ms if worker still running
async function sleepWithAbort(totalMs, worker, tickMs = 120) {
  const start = Date.now();
  while (worker.running && (Date.now() - start) < totalMs) {
    const remaining = totalMs - (Date.now() - start);
    await new Promise(res => setTimeout(res, Math.min(tickMs, Math.max(10, remaining))));
  }
}

// Helper: small wrapper to normalize thread id
function getThreadId(thread) {
  return thread.thread_id || thread.thread?.thread_id || null;
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

  // Get owner identity (authenticated user) — we'll restrict commands to this user only
  let owner = { pk: null, username: null };
  try {
    if (ig.account && typeof ig.account.currentUser === 'function') {
      const me = await ig.account.currentUser();
      owner.pk = me.pk ? String(me.pk) : (me.id ? String(me.id) : owner.pk);
      owner.username = me.username ? String(me.username) : owner.username;
    } else if (ig.state && ig.state.cookieUserId) {
      owner.pk = String(ig.state.cookieUserId);
    }
    // fallback: try to read session file to infer username if present (best-effort)
    if ((!owner.pk || !owner.username) && fs.existsSync(SESSION_FILE)) {
      try {
        const raw = fs.readFileSync(SESSION_FILE, 'utf8');
        const s = JSON.parse(raw);
        if (!owner.username && s.username) owner.username = String(s.username);
        if (!owner.pk && s.pk) owner.pk = String(s.pk);
      } catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.warn('⚠️ Could not fetch owner info:', e && e.message ? e.message : e);
  }
  console.log(`Logat ca: ${owner.username || '(unknown)'} ${owner.pk ? `(id:${owner.pk})` : ''}`);

  // NEW: Ask user if they want /start and /stop commands
  console.log('\nVrei comenzi de /start și /stop?');
  console.log('1. da');
  console.log('2. nu');
  const wantCommands = readline.question(chalk.red('Selectează (1 sau 2): ')).trim() === '1';

  // If they want commands, ask spam type and file path and base delay now (as requested)
  let commandModeConfig = null;
  if (wantCommands) {
    console.log('\nAlege tipul de spam:');
    console.log('1. linie pe linie');
    console.log('2. text întreg');
    const spamType = readline.question(chalk.red('Selectează (1 sau 2): ')).trim();
    const filePath = readline.question(chalk.red('Enter path to your text file with messages (one per line): ')).trim();
    let messages;
    try {
      messages = loadMessagesFromFile(filePath);
    } catch (e) {
      console.error('❌', e.message || e);
      process.exit(1);
    }
    // Note: baseDelay will be provided in the /startN command (N = seconds). We'll still ask for a fallback default.
    const delaySecInput = readline.question(chalk.red('Enter default delay seconds between sends (used only if /start has no number): ')).trim();
    let baseDelay = parseFloat(delaySecInput);
    if (isNaN(baseDelay) || baseDelay <= 0) baseDelay = 5;
    console.log(chalk.red('\nCommand mode enabled. Send /startN (e.g. /start1, /start5) inside ANY conversation to start spam there with N seconds delay. Send /stop to stop in that conversation.\n'));
    commandModeConfig = {
      spamType: spamType === '2' ? 'full' : 'line',
      messages,
      defaultDelaySec: baseDelay
    };
  }

  // If not command mode, preserve previous behavior: ask how to send, fetch inbox, select conversations, etc.
  if (!wantCommands) {
    // Alegere mod trimitere
    console.log('\nCum vrei ca botul să trimită mesajele?');
    console.log('1. Linie cu linie');
    console.log('2. Text întreg');
    var sendMode = readline.question(chalk.red('Selectează (1 sau 2): ')).trim();

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
      process.exit(1);
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

        // Determine if this thread likely a group (heuristic)
        const usersCount = g.users?.length || g.thread?.users?.length || 0;
        const isGroup = usersCount > 2 || Boolean(g.thread_title);

        try {
          await Utils.retryOperation(async () => {
            // Use robust send helper which tries multiple methods to support both DMs and groups
            await sendMessageToThread(ig, threadId, toSend, isGroup);
          }, 3, 1500);

          totalSent++;
          const now = new Date();
          console.log(
            `[${now.toLocaleTimeString()}] ✅ Sent to group ${threadId}: "${toSend}" (total sent: ${totalSent})\n` +
            `Autor: Gyovanny Srg\nOra: ${now.toLocaleTimeString()}\nData: ${now.toLocaleDateString()}\n`
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

  // -------------------------
  // COMMAND MODE (polling + per-thread control)
  // -------------------------
  // We'll poll the inbox periodically to detect /startN and /stop commands inside any conversation.
  // When /startN is seen in a thread, we launch an async worker that sends messages in loop to THAT thread
  // with delay N seconds (if N absent, use defaultDelaySec).
  // When /stop is seen in that thread, we stop the worker for that thread.
  // This implementation uses polling; it tries to be robust across different inbox shapes.

  // state maps
  const lastSeenText = new Map(); // threadId -> last seen message text (to detect new commands)
  const activeWorkers = new Map(); // threadId -> { running: bool, stop: fn }

  // helper to start worker for a thread
  async function startSpamForThread(thread, delaySec) {
    const threadId = getThreadId(thread);
    if (!threadId) return;
    if (activeWorkers.has(threadId)) {
      console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Already running on ${threadId}`);
      return;
    }
    const isGroup = (thread.users && thread.users.length > 2) || Boolean(thread.thread_title) || (thread.thread && thread.thread.users && thread.thread.users.length > 2);
    const { messages, spamType } = commandModeConfig;
    const worker = { running: true, stop: () => { worker.running = false; } };
    activeWorkers.set(threadId, worker);

    console.log(`[${new Date().toLocaleTimeString()}] ▶️ Started spam on ${threadId} with delay ${delaySec}s (type: ${spamType})`);
    let idx = 0;
    while (worker.running) {
      try {
        if (!worker.running) break;
        const toSend = (spamType === 'full') ? messages.fullText : messages.lines[idx % messages.lines.length];
        if (spamType !== 'full') idx++;
        await Utils.retryOperation(async () => {
          await sendMessageToThread(ig, threadId, toSend, isGroup);
        }, 3, 1500);
        const now = new Date();
        console.log(`[${now.toLocaleTimeString()}] ✅ Sent to ${threadId}: "${toSend}"\nAutor: Gyovanny Srg`);
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] ❌ Error sending to ${threadId}:`, err && err.message ? err.message : err);
      }
      // wait delaySec +- jitter but allow immediate stop by checking worker.running frequently
      const min = Math.max(200, delaySec * 1000 - 300);
      const max = delaySec * 1000 + 700;
      const sleepMs = Math.floor(Math.random() * (max - min + 1)) + min;
      await sleepWithAbort(sleepMs, worker);
    }

    activeWorkers.delete(threadId);
    console.log(`[${new Date().toLocaleTimeString()}] ⏹️ Stopped spam on ${threadId}`);
  }

  // helper to stop worker for a threadId (immediate)
  function stopSpamForThreadId(threadId) {
    const w = activeWorkers.get(threadId);
    if (w) {
      w.stop();
      console.log(`[${new Date().toLocaleTimeString()}] ⏹️ Stop requested for ${threadId}`);
    } else {
      console.log(`[${new Date().toLocaleTimeString()}] ⚠️ No active spam on ${threadId} to stop.`);
    }
  }

  // initial fetch to populate lastSeenText
  console.log('\n🔎 Initial fetch of inbox to start command listener...');
  try {
    const inbox = await ig.dm.getInbox();
    const threads = inbox?.inbox?.threads || inbox?.threads || [];
    for (const t of threads) {
      const tid = getThreadId(t);
      if (!tid) continue;
      const last = extractLastMessageText(t) || '';
      lastSeenText.set(tid, last);
    }
  } catch (e) {
    console.warn('⚠️ Initial inbox fetch failed:', e && e.message ? e.message : e);
  }

  console.log('✅ Command listener started. Polling for commands every 5 seconds. (Use CTRL+C to exit the whole script)\n');

  // polling loop
  let keepRunning = true;
  process.on('SIGINT', () => {
    console.log('\n⏹️ Interrupted by user. Exiting gracefully and stopping all workers...');
    keepRunning = false;
    for (const [tid, w] of activeWorkers.entries()) w.stop();
  });

  while (keepRunning) {
    try {
      const inbox = await ig.dm.getInbox();
      const threads = inbox?.inbox?.threads || inbox?.threads || [];

      for (const t of threads) {
        const tid = getThreadId(t);
        if (!tid) continue;
        const last = extractLastMessageText(t) || '';
        const prev = lastSeenText.get(tid) || '';

        // if changed and not empty, inspect for commands
        if (last && last !== prev) {
          // normalize
          const normalized = String(last).trim();
          // check for /startN or /start or /stop
          const startMatch = normalized.match(/^\/start\s*(\d+)?$/i) || normalized.match(/^\/start(\d+)$/i) || normalized.match(/^\/start-(\d+)$/i);
          const stopMatch = normalized.match(/^\/stop$/i);

          // Only allow commands from the authenticated owner
          const sender = extractLastMessageSender(t);
          let allowed = false;
          if (sender) {
            // compare both username and pk if available
            if (owner.pk && String(owner.pk) === String(sender)) allowed = true;
            if (owner.username && String(owner.username).toLowerCase() === String(sender).toLowerCase()) allowed = true;
          } else {
            // if we can't detect sender, be conservative and disallow
            allowed = false;
          }

          if (!allowed) {
            // ignore command from non-owner
            console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Ignored command in ${tid} from non-owner (${sender || 'unknown'})`);
          } else {
            // owner issued command
            if (startMatch) {
              // determine delay
              const n = startMatch[1];
              const delaySec = n ? parseFloat(n) : commandModeConfig.defaultDelaySec;
              // start worker for THIS thread
              startSpamForThread(t, delaySec).catch(err => {
                console.error('Worker start failed:', err && err.message ? err.message : err);
              });
            } else if (stopMatch) {
              stopSpamForThreadId(tid);
            } else {
              // Not a command - ignore
            }
          }
        }

        // update lastSeenText
        lastSeenText.set(tid, last);
      }
    } catch (e) {
      console.warn('⚠️ Polling error:', e && e.message ? e.message : e);
    }

    // short sleep between polls
    await Utils.randomDelay(4000, 6000);
  }

  // graceful shutdown: stop workers
  for (const [tid, w] of activeWorkers.entries()) w.stop();
  // give a moment for workers to stop
  await Utils.randomDelay(300, 800);
  try { await ig.destroy?.(); } catch (_) {}
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err?.message || err);
  process.exit(1);
});

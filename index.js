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
const OWNER_FILE = path.resolve(process.cwd(), 'owner.json'); // persisted owner info

// ===== Banner =====
console.log(chalk.bold.red("\n=========================================="));
console.log(chalk.bold.red("GYOVANNY INSTAGRAM SPAM BOT 🔥"));
console.log(chalk.bold.red("==========================================\n"));

// ===== Override console.log/warn/error to always show red =====
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

console.log = (...args) => {
  try {
    originalLog(chalk.red(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  } catch {
    originalLog(args.join(' '));
  }
};
console.warn = (...args) => {
  try {
    originalWarn(chalk.red(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  } catch {
    originalWarn(args.join(' '));
  }
};
console.error = (...args) => {
  try {
    originalError(chalk.red(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  } catch {
    originalError(args.join(' '));
  }
};

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
    if (typeof ig.saveSession === 'function') {
      const session = await ig.saveSession();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
      try { fs.writeFileSync(SESSION_BACKUP, JSON.stringify(session, null, 2), { mode: 0o600 }); } catch (_) {}
      console.log('🔐 Session saved successfully.');
      return;
    }
    console.warn('⚠️ Could not find save session function on client.');
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
      console.log('→ cookies is', info.cookiesType === 'string' ? 'string (prob serialized)' : 'object');
      console.log('   cookies count:', info.cookieCount);
      console.log('   cookie keys (first 20):', info.cookieKeys);
      console.log('authorization present?', info.hasAuthorization);
      console.log('igWWWClaim present?', info.hasIgWWWClaim);
      console.log('passwordEncryptionKeyId present?', info.passwordEncryptionKeyId);
      console.warn(`⚠️ Saved session in ${p} is not valid.`);
    } catch (e) {
      console.warn('⚠️ Failed to load session from', p, ':', e && e.message ? e.message : e);
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

// Owner file helpers
function loadOwnerFile() {
  try {
    if (!fs.existsSync(OWNER_FILE)) return null;
    const raw = fs.readFileSync(OWNER_FILE, 'utf8');
    if (!raw || !raw.trim()) return null;
    const o = JSON.parse(raw);
    if (!o) return null;
    // normalize
    if (o.pk) o.pk = digitsOnly(o.pk) || o.pk;
    if (o.username) o.username = String(o.username).toLowerCase().replace(/^@/, '').trim();
    return o;
  } catch (e) {
    console.warn('⚠️ Failed to read owner file:', e && e.message ? e.message : e);
    return null;
  }
}

function saveOwnerFile(owner) {
  try {
    fs.writeFileSync(OWNER_FILE, JSON.stringify(owner, null, 2), { mode: 0o600 });
    console.log(`🔐 Owner saved to ${OWNER_FILE}: ${owner.username || owner.pk}`);
  } catch (e) {
    console.warn('⚠️ Failed to save owner file:', e && e.message ? e.message : e);
  }
}

// When authenticated, set owner to the authenticated account and persist (overwrites previous owner.json)
async function setOwnerFromAuthenticatedUser(ig) {
  try {
    if (ig.account && typeof ig.account.currentUser === 'function') {
      const me = await ig.account.currentUser();
      const pk = me.pk ? String(me.pk) : (me.id ? String(me.id) : null);
      const username = me.username ? String(me.username) : null;
      const owner = { pk: pk ? digitsOnly(pk) || pk : null, username: username ? String(username).toLowerCase().replace(/^@/, '').trim() : null };
      if (owner.pk || owner.username) {
        saveOwnerFile(owner);
        console.log(`🔁 Owner set from authenticated user -> username: ${owner.username || '(unknown)'} pk: ${owner.pk || '(unknown)'}`);
        return owner;
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to set owner from authenticated user:', e && e.message ? e.message : e);
  }
  return null;
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

// Helper: extract last message sender robustly from thread object
// Returns an object: { username: string|null, pk: string|null }
function extractLastMessageSender(thread) {
  try {
    // last_permanent_item often used
    if (thread.last_permanent_item) {
      const l = thread.last_permanent_item;
      if (l.user && (l.user.username || l.user.pk)) {
        return { username: l.user.username || null, pk: l.user.pk ? String(l.user.pk) : (l.user.id ? String(l.user.id) : null) };
      }
      if (l.user_id) return { username: null, pk: String(l.user_id) };
    }

    // thread.items shape
    if (thread.items && Array.isArray(thread.items) && thread.items.length > 0) {
      const it = thread.items[0];
      if (it.user) {
        return { username: it.user.username || null, pk: it.user.pk ? String(it.user.pk) : (it.user.id ? String(it.user.id) : null) };
      }
      if (it.account) {
        return { username: it.account.username || null, pk: it.account.pk ? String(it.account.pk) : (it.account.id ? String(it.account.id) : null) };
      }
      if (it.message && it.message.user_id) {
        return { username: null, pk: String(it.message.user_id) };
      }
      if (it.user_id) return { username: null, pk: String(it.user_id) };
      // sometimes text items include username
      if (it.text && it.user && it.user.username) return { username: it.user.username, pk: it.user.pk ? String(it.user.pk) : null };
    }

    // thread.thread.last_message
    if (thread.thread && thread.thread.last_message) {
      const lm = thread.thread.last_message;
      if (lm.user && (lm.user.username || lm.user.pk)) {
        return { username: lm.user.username || null, pk: lm.user.pk ? String(lm.user.pk) : (lm.user.id ? String(lm.user.id) : null) };
      }
      if (lm.user_id) return { username: null, pk: String(lm.user_id) };
      if (lm.username) return { username: lm.username, pk: null };
    }

    // last_message root
    if (thread.last_message) {
      if (typeof thread.last_message === 'string') {
        return { username: null, pk: null };
      }
      if (thread.last_message.user && (thread.last_message.user.username || thread.last_message.user.pk)) {
        return { username: thread.last_message.user.username || null, pk: thread.last_message.user.pk ? String(thread.last_message.user.pk) : null };
      }
      if (thread.last_message.user_id) return { username: null, pk: String(thread.last_message.user_id) };
    }

  } catch (e) { /* ignore */ }
  return { username: null, pk: null };
}

// Normalize helper: keep only digits for numeric ids
function digitsOnly(s) {
  if (!s) return null;
  const m = String(s).match(/\d+/g);
  if (!m) return null;
  return m.join('');
}

// Compare detected sender with owner info
// Modified to be more permissive/robust and to allow partial numeric suffix matches
function isSenderOwner(senderObj, owner, overrideOwnerUsernames) {
  // senderObj: { username: string|null, pk: string|null }
  // owner: { pk: string|null, username: string|null }
  // overrideOwnerUsernames: array|null
  try {
    if (!senderObj) return false;

    // Normalize sender fields
    const senderUsername = senderObj.username ? String(senderObj.username).toLowerCase().replace(/^@/, '').trim() : null;
    const senderPkDigits = senderObj.pk ? digitsOnly(senderObj.pk) : null;

    // 1) If override list provided, check username against it first (exact match)
    if (Array.isArray(overrideOwnerUsernames) && overrideOwnerUsernames.length > 0) {
      if (senderUsername) {
        if (overrideOwnerUsernames.includes(senderUsername)) return true;
      }
      // Also allow override entries that are numeric IDs - compare digits
      if (senderPkDigits) {
        for (const v of overrideOwnerUsernames) {
          const vDigits = digitsOnly(v);
          if (vDigits && vDigits === senderPkDigits) return true;
          // allow suffix match if one side shorter (defensive)
          if (vDigits && senderPkDigits.endsWith(vDigits)) return true;
          if (vDigits && vDigits.endsWith(senderPkDigits)) return true;
        }
      }
    }

    // 2) Fallback to owner object check
    const ownerPkDigits = owner && owner.pk ? digitsOnly(owner.pk) : null;
    const ownerUsername = owner && owner.username ? String(owner.username).toLowerCase().replace(/^@/, '').trim() : null;

    // If both PKs present, prefer direct equality
    if (senderPkDigits && ownerPkDigits) {
      if (senderPkDigits === ownerPkDigits) return true;
      // Accept if one is suffix of the other (sometimes session stores extra prefixes)
      if (senderPkDigits.endsWith(ownerPkDigits) || ownerPkDigits.endsWith(senderPkDigits)) return true;
    }

    // If username available on both sides, compare normalized
    if (senderUsername && ownerUsername) {
      if (senderUsername === ownerUsername) return true;
    }

    // If sender has username and owner only has pk, sometimes username contains digits; check numeric content
    if (senderUsername && ownerPkDigits) {
      const numericInSender = digitsOnly(senderUsername);
      if (numericInSender && numericInSender === ownerPkDigits) return true;
    }

    // As last resort, if owner.pk missing but ownerUsername available, check if sender.pk or username contains ownerUsername
    if (!ownerPkDigits && ownerUsername) {
      if (senderPkDigits && String(senderPkDigits).includes(ownerUsername)) return true;
      if (senderUsername && senderUsername.includes(ownerUsername)) return true;
    }

    return false;

  } catch (e) {
    return false;
  }
}

// Helper: try to get owner info from session.json file (robust)
function loadOwnerFromSessionFile() {
  const owner = { pk: null, username: null };
  try {
    if (!fs.existsSync(SESSION_FILE)) return owner;
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    if (!raw || !raw.trim()) return owner;
    const s = JSON.parse(raw);

    // check common fields
    // Many session shapes: { username, pk }, { account_id, user_id, user }, {cookies:...}
    if (s.username) owner.username = String(s.username);
    if (s.pk) owner.pk = String(s.pk);
    if (s.user_id) owner.pk = String(s.user_id);
    if (s.user && typeof s.user === 'object') {
      if (s.user.pk) owner.pk = String(s.user.pk);
      if (s.user.username) owner.username = String(s.user.username);
      if (s.user.id && !owner.pk) owner.pk = String(s.user.id);
    }
    if (!owner.pk && s.account_id) owner.pk = String(s.account_id);
    // some wrappers store { account: { pk, username } }
    if (s.account && typeof s.account === 'object') {
      if (!owner.pk && (s.account.pk || s.account.id)) owner.pk = String(s.account.pk || s.account.id);
      if (!owner.username && s.account.username) owner.username = String(s.account.username);
    }
    // sometimes nested under state or module keys
    if (!owner.username && s.state && s.state.username) owner.username = String(s.state.username);
    if (!owner.pk && s.state && s.state.cookieUserId) owner.pk = String(s.state.cookieUserId);
    if (!owner.pk && s.state && s.state.userId) owner.pk = String(s.state.userId);

    // Try searching cookie strings for ds_user_id or similar markers (string cookies)
    if (!owner.pk && s.cookies && typeof s.cookies === 'string') {
      // try to find ds_user_id or user_id in cookie string
      const m = s.cookies.match(/ds_user_id=(\d+)/);
      if (m && m[1]) owner.pk = String(m[1]);
      const m2 = s.cookies.match(/user_id=(\d+)/);
      if (!owner.pk && m2 && m2[1]) owner.pk = String(m2[1]);
    }

    // Additional fallback: some session shapes include "client" / "config" nested fields
    if (!owner.pk) {
      const findPkInObj = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.pk) return String(obj.pk);
        if (obj.user_id) return String(obj.user_id);
        if (obj.id) return String(obj.id);
        for (const k of Object.keys(obj)) {
          try {
            const v = obj[k];
            if (v && typeof v === 'object') {
              const r = findPkInObj(v);
              if (r) return r;
            }
          } catch (e) { /* ignore */ }
        }
        return null;
      };
      const extra = findPkInObj(s);
      if (extra) owner.pk = extra;
    }

    // lastly, convert numeric-like owner.pk to digits-only string
    if (owner.pk) owner.pk = digitsOnly(owner.pk) || owner.pk;

  } catch (e) {
    // ignore parsing errors
  }
  return owner;
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

  // After successful login / session load, set owner to authenticated user and persist.
  // This ensures whoever authenticates becomes owner (overwrites previous owner.json).
  let owner = { pk: null, username: null };
  try {
    const setOwner = await setOwnerFromAuthenticatedUser(ig);
    if (setOwner) {
      owner = setOwner;
    }
  } catch (e) {
    // ignore - we'll fallback to other sources below
    console.warn('⚠️ setOwnerFromAuthenticatedUser error:', e && e.message ? e.message : e);
  }

  // If for some reason above didn't set owner, try to load from session.json (fallback)
  try {
    if ((!owner.pk && !owner.username)) {
      const fromSession = loadOwnerFromSessionFile();
      if (fromSession && (fromSession.pk || fromSession.username)) {
        if (fromSession.pk) owner.pk = fromSession.pk;
        if (fromSession.username) owner.username = fromSession.username;
      }
    }
  } catch (e) {
    // ignore
  }

  // Try to load persisted owner.json (if present and not already set by authenticated user)
  try {
    const persisted = loadOwnerFile();
    if (persisted && (persisted.pk || persisted.username)) {
      // If owner was set from authenticated user, trust that (it overwrote file).
      // If owner not set yet, use persisted.
      if (!owner.pk && !owner.username) {
        owner.pk = persisted.pk || owner.pk;
        owner.username = persisted.username || owner.username;
        console.log(`🔁 Loaded persisted owner from owner.json -> username: ${owner.username || '(unknown)'} pk: ${owner.pk || '(unknown)'}`);
      } else {
        // owner already set (likely from authenticated user) - ensure persisted file matches (it should have been overwritten)
        // If mismatch, overwrite persisted to match current authenticated owner:
        if ((owner.pk && persisted.pk !== owner.pk) || (owner.username && persisted.username !== owner.username)) {
          try { saveOwnerFile(owner); } catch (e) { /* ignore */ }
          console.log('🔁 Persisted owner did not match authenticated user - owner.json updated.');
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // normalize owner fields
  if (owner.pk) owner.pk = digitsOnly(owner.pk) || owner.pk;
  if (owner.username) owner.username = String(owner.username).toLowerCase().replace(/^@/, '').trim();

  // DEBUG: show resolved owner info so user can verify
  console.log(`Resolved owner info -> username: ${owner.username || '(unknown)'} , pk: ${owner.pk || '(unknown)'}`);

  // Build override list from resolved owner.username if available; otherwise empty array
  let overrideOwnerUsernames = [];
  if (owner.username) overrideOwnerUsernames = [String(owner.username).toLowerCase().replace(/^@/, '').trim()];

  console.log(`Logat ca: ${owner.username || '(unknown)'} ${owner.pk ? (`(id:${owner.pk})`) : ''}`);
  console.log(`Override owner usernames (auto): ${JSON.stringify(overrideOwnerUsernames)}`);

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
    // enforce minimum 1s to avoid instant loops
    baseDelay = Math.max(1, baseDelay);
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
    baseDelay = Math.max(0.2, baseDelay); // allow fractional but not zero
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
  if (!commandModeConfig) {
    console.error('❌ Command mode config missing. Exiting.');
    process.exit(1);
  }

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
          // debug: show what changed
          const senderObj = extractLastMessageSender(t); // { username, pk }
          console.log(`[${new Date().toLocaleTimeString()}] [DEBUG] thread=${tid} prev="${prev}" -> last="${last}" sender=${JSON.stringify(senderObj)}`);

          // normalize (trim invisible whitespace)
          const normalized = String(last || '').trim();

          // More permissive start regex: /start , /startN, /start-N, / startN etc.
          const startMatch = normalized.match(/\/\s*start(?:[-\s]?(\d+))?/i);
          const stopMatch = normalized.match(/\/\s*stop\b/i);

          // If owner not set (both pk & username missing), and this message looks like a command,
          // auto-assign owner to the sender and persist it.
          if ((!owner.pk && !owner.username) && (startMatch || stopMatch)) {
            const proposedPk = senderObj.pk ? digitsOnly(senderObj.pk) : null;
            const proposedUsername = senderObj.username ? String(senderObj.username).toLowerCase().replace(/^@/, '').trim() : null;
            if (proposedPk || proposedUsername) {
              owner.pk = proposedPk || null;
              owner.username = proposedUsername || (proposedPk ? `user_${proposedPk}` : null);
              if (owner.pk) owner.pk = digitsOnly(owner.pk) || owner.pk;
              if (owner.username) owner.username = String(owner.username).toLowerCase().replace(/^@/, '').trim();
              // persist
              saveOwnerFile(owner);
              // update overrideOwnerUsernames so that subsequent checks use it
              overrideOwnerUsernames = owner.username ? [owner.username] : [];
              console.log(`[${new Date().toLocaleTimeString()}] 🔐 Owner automatically set to ${owner.username || owner.pk}`);
            }
          }

          let allowed = false;
          try {
            allowed = isSenderOwner(senderObj, owner, overrideOwnerUsernames);
          } catch (e) {
            allowed = false;
          }

          if (!allowed) {
            // ignore command from non-owner, but log reason (improved debug)
            const displaySender = (senderObj && (senderObj.username || senderObj.pk)) ? (senderObj.username || senderObj.pk) : 'unknown';
            // Provide extra debug about owner vs sender for easier diagnosis
            const sPk = senderObj.pk ? digitsOnly(senderObj.pk) : null;
            const oPk = owner.pk ? owner.pk : null;
            const sUser = senderObj.username ? senderObj.username : null;
            const oUser = owner.username ? owner.username : null;
            console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Ignored command in ${tid} from non-owner (${displaySender}). sender.pk=${sPk} sender.username=${sUser} | owner.pk=${oPk} owner.username=${oUser} overrideList=${JSON.stringify(overrideOwnerUsernames)}`);
          } else {
            // owner issued command
            if (startMatch) {
              // determine delay (capture group 1)
              const n = startMatch[1];
              let delaySec = n ? parseFloat(n) : commandModeConfig.defaultDelaySec;
              if (isNaN(delaySec) || delaySec <= 0) delaySec = Math.max(1, commandModeConfig.defaultDelaySec);
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

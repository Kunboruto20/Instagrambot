const { Utils } = require("nodejs-insta-private-api/dist/utils");
/**
 * index.js
 * Instagram Bot Gyovanny - final updated (robust text extraction + thread fetch fallback)
 *
 * Requirements:
 *  - npm install instagram-private-api fs-extra readline-sync chalk
 *
 * Single-file, Termux-compatible.
 */

const { IgApiClient } = require('instagram-private-api');
const readline = require('readline-sync');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');

const SESSION_FILE = path.resolve(process.cwd(), 'session.json');
const OWNER_FILE = path.resolve(process.cwd(), 'owner.json');

const AUTO_SAVE_INTERVAL_MS = 60_000;
const POLLING_INTERVAL_MS = 3000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 120_000;
const SESSIONID_WAIT_MAX_MS = 20_000;
const SESSIONID_WAIT_STEP_MS = 800;

// Rate-limit / sending controls
const GLOBAL_MIN_SEND_INTERVAL = 800; // ms between global sends baseline
const PER_THREAD_MIN_INTERVAL = 2000; // ms minimal delay per thread (applied after first send)
const JITTER_MAX_MS = 600; // random extra ms to add to delays
const MAX_429_BACKOFF_MS = 120_000;

console.log(chalk.red.bold('====================================='));
console.log(chalk.red.bold('        Instagram Bot Gyovanny       '));
console.log(chalk.red.bold('=====================================\n'));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleString(); }

async function saveSession(ig) {
  try {
    if (!ig || !ig.state) return;
    const serialized = await ig.state.serialize();
    delete serialized.constants;
    await fs.writeFile(SESSION_FILE, JSON.stringify(serialized, null, 2), 'utf8');
    console.log(chalk.red(`[session] Saved session to ${SESSION_FILE}`));
  } catch (err) {
    console.log(chalk.red('[session] Failed to save session:'), err && err.message ? err.message : err);
  }
}

async function tryLoadSessionOnly(ig) {
  // Attempt to load session if session.json exists. Returns true if loaded.
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    const state = JSON.parse(raw);
    await ig.state.deserialize(state);
    console.log(chalk.red(`[session] Deserialized session from ${SESSION_FILE}`));
    return true;
  } catch (err) {
    console.log(chalk.red('[session] Failed to deserialize session:'), err && err.message ? err.message : err);
    return false;
  }
}

async function loadSession(ig) {
  // Backwards-compatible loader (keeps previous behaviour)
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    const state = JSON.parse(raw);
    await ig.state.deserialize(state);
    console.log(chalk.red(`[session] Loaded session from ${SESSION_FILE}`));
    return true;
  } catch (err) {
    console.log(chalk.red('[session] Failed to load session (will login):'), err && err.message ? err.message : err);
    return false;
  }
}

async function saveOwner(ownerObj) {
  try {
    await fs.writeFile(OWNER_FILE, JSON.stringify(ownerObj, null, 2), 'utf8');
    console.log(chalk.red(`[owner] Saved owner to ${OWNER_FILE}`));
  } catch (e) {
    console.log(chalk.red('[owner] Failed to save owner:'), e && e.message ? e.message : e);
  }
}

async function loadOwner() {
  if (!fs.existsSync(OWNER_FILE)) return null;
  try {
    const raw = await fs.readFile(OWNER_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function parseStartCmd(text) {
  if (!text) return null;
  const m = text.trim().match(/^\/start(\d*\.?\d*)$/i);
  if (!m) return null;
  const n = m[1] ? parseFloat(m[1]) : 1;
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

// traverse serialized state to find sessionid cookie value (best-effort)
function findSessionId(obj) {
  if (!obj) return null;
  if (typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const v = findSessionId(el);
      if (v) return v;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    if (k && typeof k === 'string' && k.toLowerCase().includes('cookie')) {
      if (Array.isArray(val)) {
        for (const c of val) {
          if (!c) continue;
          if ((c.name === 'sessionid' || c.key === 'sessionid') && (c.value || c.val)) {
            return c.value || c.val;
          }
          if (c.sessionid) return c.sessionid;
        }
      } else if (val && typeof val === 'object') {
        const nested = findSessionId(val);
        if (nested) return nested;
      }
    }
    if (k === 'sessionid' && typeof val === 'string') return val;
    const nested = findSessionId(val);
    if (nested) return nested;
  }
  return null;
}

// helpers to extract from directInbox thread objects
function displayThreadSummary(t, idx) {
  try {
    const title = t.thread_title || t.thread_title || t.thread_title || null;
    const participants = (t.users || t.participants || []).map(u => u.username || u.pk || u.id).slice(0,5);
    const threadId = t.thread_id || t.threadId || t.id || 'unknown';
    return `${String(idx).padStart(2,' ')}. [${threadId}] ${title || '(no title)'} — participants: ${participants.join(', ')}`;
  } catch (e) { return `${idx}. (err reading thread)`; }
}

// display only name/title (or fallback to first participant or "(no title)")
function displayThreadName(t, idx) {
  try {
    const title = (t.thread_title && String(t.thread_title).trim()) || null;
    if (title) return `${String(idx).padStart(2,' ')}. ${title}`;
    const participants = (t.users || t.participants || []).map(u => u.username || u.pk || u.id).filter(Boolean);
    if (participants.length) return `${String(idx).padStart(2,' ')}. ${participants[0]}`;
    return `${String(idx).padStart(2,' ')}. (no title)`;
  } catch (e) { return `${idx}. (err reading thread)`; }
}

function extractTopItem(t) {
  try { return (t.items && t.items[0]) || null; } catch(e){ return null; }
}
function extractFromUserIdFromTopItem(top) {
  try {
    if (!top) return null;
    // common locations
    if (top.user_id) return String(top.user_id);
    if (top.user && (top.user.pk || top.user.id)) return String(top.user.pk || top.user.id);
    if (top.sender_id) return String(top.sender_id);
    if (top._sender && (top._sender.pk || top._sender.id)) return String(top._sender.pk || top._sender.id);
    // nested message structures
    if (top.item && top.item.user_id) return String(top.item.user_id);
    if (top.user_id_str) return String(top.user_id_str);
    if (top.user && top.user.pk) return String(top.user.pk);
    // try common nested path: top.item.user.pk etc
    if (top.item && top.item.user && (top.item.user.pk || top.item.user.id)) return String(top.item.user.pk || top.item.user.id);
    return null;
  } catch (e) { return null; }
}
function extractTextFromTopItem(top) {
  try {
    if (!top) return null;
    // common direct properties
    if (typeof top.text === 'string' && top.text.trim()) return top.text.trim();
    if (typeof top.message === 'string' && top.message.trim()) return top.message.trim();
    if (typeof top.text_body === 'string' && top.text_body.trim()) return top.text_body.trim();
    if (typeof top.caption === 'string' && top.caption.trim()) return top.caption.trim();
    if (typeof top.story_share_text === 'string' && top.story_share_text.trim()) return top.story_share_text.trim();
    // sometimes text is in an array of texts
    if (Array.isArray(top.texts) && top.texts.length) {
      for (const t of top.texts) {
        if (typeof t === 'string' && t.trim()) return t.trim();
        if (t && typeof t === 'object' && typeof t.text === 'string' && t.text.trim()) return t.text.trim();
      }
    }
    // nested item/message objects
    if (top.item && typeof top.item === 'object') {
      if (typeof top.item.text === 'string' && top.item.text.trim()) return top.item.text.trim();
      if (typeof top.item.message === 'string' && top.item.message.trim()) return top.item.message.trim();
      if (top.item && top.item.message && typeof top.item.message.text === 'string' && top.item.message.text.trim()) return top.item.message.text.trim();
    }
    // some variants use 'textPreview' or 'text' under 'message' object
    if (top.message && typeof top.message === 'object') {
      if (typeof top.message.text === 'string' && top.message.text.trim()) return top.message.text.trim();
      if (typeof top.message.textPreview === 'string' && top.message.textPreview.trim()) return top.message.textPreview.trim();
    }
    // try to find any string field that looks like message
    for (const k of Object.keys(top)) {
      if (typeof top[k] === 'string' && top[k].length > 0 && k.toLowerCase().includes('text')) return top[k].trim();
      if (typeof top[k] === 'string' && top[k].length > 0 && (k.toLowerCase().includes('message') || k.toLowerCase().includes('body'))) return top[k].trim();
    }
    return null;
  } catch (e) { return null; }
}

// fallback: fetch the full thread and search recent items for the latest text message
async function fetchLatestTextFromThread(igClient, threadId) {
  try {
    const resp = await igClient.feed.directThread(threadId).request();
    const items = resp.items || resp.thread_items || resp.items || resp.items || resp.inbox_items || [];
    // items may be in order newest-first, or oldest-first; try newest-first
    const arr = Array.isArray(items) ? items.slice().reverse() : [];
    // If empty reversed, fallback to original
    const check = arr.length ? arr : Array.isArray(items) ? items : [];
    for (const it of check.reverse ? check.reverse() : check) {
      const top = it;
      const text = extractTextFromTopItem(top);
      const from = extractFromUserIdFromTopItem(top);
      if (text && from) return { text, from };
      // sometimes structure: it.item or it.message
      const nested = it.item || it.message || null;
      if (nested) {
        const t = extractTextFromTopItem(nested);
        const f = extractFromUserIdFromTopItem(nested) || extractFromUserIdFromTopItem(it);
        if (t && f) return { text: t, from: f };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// boxed red log for sent spam (user requested exact format, all red)
function boxedSentLog(threadName, txt) {
  const line1 = '─────────────── SPAM SENT ✅ ───────────────';
  const line3 = `Grup: ${threadName}`;
  const line4 = `Mesaj: "${txt.length > 240 ? txt.slice(0,240) + '...' : txt}"`;
  const line5 = 'Autor: Gyovanny Srg';
  const line6 = '────────────────────────────────────────────';
  console.log(chalk.red(line1));
  console.log(chalk.red(line3));
  console.log(chalk.red(line4));
  console.log(chalk.red(line5));
  console.log(chalk.red(line6));
}

/**
 * Helper: deterministic line retrieval (preserve original file order)
 * - 'lines' is an array produced by raw.split(/\r?\n/)
 * - 'state' is an object with numeric 'idx' (index pointer)
 * Returns object { line, nextIdx }
 * Behavior: finds the next non-empty line starting from state.idx; if none found (all empty),
 * returns an empty string and advances pointer circularly.
 */
function getNextLine(lines, state) {
  if (!Array.isArray(lines) || lines.length === 0) {
    state.idx = 0;
    return { line: '', nextIdx: 0 };
  }
  const total = lines.length;
  // ensure idx in range
  let start = (typeof state.idx === 'number' ? state.idx : 0) % total;
  if (start < 0) start += total;

  // attempt to find next non-empty line, scanning at most 'total' entries (keeps order)
  for (let attempt = 0; attempt < total; attempt++) {
    const current = start % total;
    const rawLine = lines[current];
    // preserve exact content, but treat strings that are entirely whitespace as empty
    const isNonEmpty = typeof rawLine === 'string' && rawLine.replace(/\s/g, '').length > 0;
    if (isNonEmpty) {
      const nextIdx = (current + 1) % total;
      return { line: rawLine, nextIdx };
    }
    start = (start + 1) % total;
  }

  // If we get here, all lines are empty/whitespace — return empty and advance pointer by 1
  const nextIdx = (state.idx + 1) % total;
  return { line: '', nextIdx };
}

(async () => {
  try {
    const ig = new IgApiClient();

    // Try to auto-load session without prompting (user requested)
    let hadSession = false;
    try {
      hadSession = await tryLoadSessionOnly(ig);
    } catch (e) { hadSession = false; }

    let username = null;
    let password = null;

    if (!hadSession) {
      // prompt credentials and login
      username = readline.question('Enter your Instagram username: ').trim();
      password = readline.question('Enter your Instagram password: ', { hideEchoBack: true }).trim();
      // generate device based on username before login
      ig.state.generateDevice(username);

      try { await ig.simulate.preLoginFlow(); } catch {}
      await ig.account.login(username, password);
      try { await ig.simulate.postLoginFlow(); } catch {}
      console.log(chalk.red(`✅ Logged in as ${username}`));
      await saveSession(ig);
      hadSession = true;
    } else {
      // session was loaded; try to validate it by calling currentUser
      try {
        const me = await ig.account.currentUser();
        username = me.username;
        console.log(chalk.red(`✅ Session valid — logged in as ${username}`));
      } catch (err) {
        // fallback: session deserialize failed to log in; prompt credentials
        console.log(chalk.red('[session] Session invalid on validation, will login with credentials...'));
        username = readline.question('Enter your Instagram username: ').trim();
        password = readline.question('Enter your Instagram password: ', { hideEchoBack: true }).trim();
        ig.state.generateDevice(username);
        try { await ig.simulate.preLoginFlow(); } catch {}
        await ig.account.login(username, password);
        try { await ig.simulate.postLoginFlow(); } catch {}
        console.log(chalk.red(`✅ Logged in as ${username}`));
        await saveSession(ig);
      }
    }

    // autosave
    setInterval(() => saveSession(ig), AUTO_SAVE_INTERVAL_MS).unref();

    // OWNER flow (unchanged but improved resolution)
    let ownerObj = await loadOwner();
    let allowedOwnerIds = new Set();
    if (ownerObj && (ownerObj.ownerId || ownerObj.ownerUsername)) {
      if (ownerObj.ownerId) allowedOwnerIds.add(String(ownerObj.ownerId));
      if (ownerObj.ownerUsername) {
        try {
          const userInfo = await ig.user.searchExact(ownerObj.ownerUsername);
          if (userInfo && (userInfo.pk || userInfo.id)) {
            allowedOwnerIds.add(String(userInfo.pk || userInfo.id));
            ownerObj.ownerId = String(userInfo.pk || userInfo.id);
            await saveOwner(ownerObj);
          }
        } catch (e) {}
      }
      console.log(chalk.red(`[owner] Loaded owner from ${OWNER_FILE}: ${ownerObj.ownerUsername || ownerObj.ownerId}`));
    } else {
      console.log('\nSetează owner-ul (cine poate folosi comenzile).');
      console.log('1. Folosesc contul conectat curent (recomandat)');
      console.log('2. Introdu username alt cont (ex: alt_user)');
      const pick = readline.question('Alege (1 sau 2): ').trim();
      if (pick === '1') {
        try {
          const me = await ig.account.currentUser();
          const id = String(me.pk || me.id);
          const usernameResolved = me.username || username;
          ownerObj = { ownerId: id, ownerUsername: usernameResolved };
          allowedOwnerIds.add(id);
          await saveOwner(ownerObj);
          console.log(chalk.red(`[owner] Set owner to current account: ${usernameResolved} (${id})`));
        } catch (e) {
          console.log(chalk.red('[owner] Eroare la setarea owner-ului din contul curent:'), e && e.message ? e.message : e);
        }
      } else {
        const ownerUsername = readline.question('Introdu username-ul owner (ex: alt_user): ').trim();
        try {
          const userInfo = await ig.user.searchExact(ownerUsername);
          if (userInfo && (userInfo.pk || userInfo.id)) {
            const id = String(userInfo.pk || userInfo.id);
            ownerObj = { ownerId: id, ownerUsername: ownerUsername };
            allowedOwnerIds.add(id);
            await saveOwner(ownerObj);
            console.log(chalk.red(`[owner] Owner set to ${ownerUsername} (${id})`));
          } else {
            console.log(chalk.red('[owner] Nu am putut gasi userul — owner nu e setat'));
          }
        } catch (e) {
          console.log(chalk.red('[owner] Eroare la cautare user:'), e && e.message ? e.message : e);
        }
      }
    }

    // Ensure owner fallback
    if (ownerObj && ownerObj.ownerId && allowedOwnerIds.size === 0) {
      allowedOwnerIds.add(String(ownerObj.ownerId));
    }
    if (allowedOwnerIds.size === 0) {
      try {
        const me = await ig.account.currentUser();
        const id = String(me.pk || me.id);
        allowedOwnerIds.add(id);
        ownerObj = ownerObj || {};
        ownerObj.ownerId = id;
        ownerObj.ownerUsername = me.username || username;
        await saveOwner(ownerObj);
        console.log(chalk.red(`[owner] Fallback owner set to logged account: ${ownerObj.ownerUsername} (${id})`));
      } catch (e) {
        console.log(chalk.red('[owner] Nu am putut seta owner fallback'));
      }
    }
    console.log(chalk.red(`[owner] Owner ID(s) permis(e): ${Array.from(allowedOwnerIds).join(', ')}`));

    // helper to build entity with checks
    function makeThreadEntity(threadIdOrUsers) {
      try {
        const ent = ig.entity.directThread(threadIdOrUsers);
        return ent;
      } catch (e) {
        return null;
      }
    }

    // If user picked commands (wantCmd true) -> keep command mode logic
    console.log('\nVrei comenzi de /start și /stop?');
    console.log('1. da');
    console.log('2. nu');
    const want = readline.question('Alege (1 sau 2): ').trim();
    const wantCmd = want === '1';

    // active sending sessions map (threadId -> { running, delay, idx, ent })
    const activeSessions = new Map();

    if (wantCmd) {
      // Command-mode flow
      let textPath = readline.question('Enter your text path here (ex: /storage/emulated/0/mesaje.txt): ').trim();
      if (!fs.existsSync(textPath)) {
        console.log(chalk.red('Fișierul nu exista:'), textPath);
        process.exit(1);
      }
      const raw = await fs.readFile(textPath, 'utf8');

      // *** IMPORTANT CHANGE HERE: preserve order of lines EXACTLY as in file ***
      // split into lines preserving empty lines. We'll skip empty lines when sending, but the order is kept.
      const lines = raw.split(/\r?\n/);

      if (!Array.isArray(lines) || lines.length === 0) {
        console.log(chalk.red('Fișierul text gol. Ies.'));
        process.exit(1);
      }
      console.log(chalk.red(`Fișier incarcat — ${lines.length} linii (incluzand eventuale linii goale).`));

      function parseStartCmdLocal(text) {
        if (!text) return null;
        const m = text.trim().match(/^\/start(\d*\.?\d*)$/i);
        if (!m) return null;
        const n = m[1] ? parseFloat(m[1]) : 1;
        return (!Number.isFinite(n) || n < 0) ? 1 : n;
      }

      async function startSending(threadId, delaySec) {
        if (activeSessions.get(threadId)?.running) {
          console.log(chalk.red(`[session] Attempt to start already-running session on ${threadId}`));
          return;
        }
        const ent = makeThreadEntity(threadId);
        if (!ent) {
          console.log(chalk.red(`[session] Nu pot construi directThread pentru ${threadId}`));
          return;
        }

        // attempt to fetch thread info for nicer logs (best-effort)
        let threadInfo = null;
        try {
          const info = await ig.feed.directThread(threadId).request();
          threadInfo = info; // keep full object
        } catch (e) {
          // ignore, we'll log using threadId fallback
        }

        // state.idx will be pointer into lines array (preserve order)
        const state = { running: true, delay: Math.max(0, Number(delaySec) || 1), idx: 0, ent, firstSent: false, threadObj: threadInfo };
        activeSessions.set(threadId, state);
        console.log(chalk.red(`[session] START pe ${threadId} delay ${state.delay}s`));

        // ensure first send can go immediate
        while (state.running) {
          // get next non-empty line in order (deterministic)
          const { line: txt, nextIdx } = getNextLine(lines, state);
          state.idx = nextIdx;

          if (!txt || txt.replace(/\s/g, '').length === 0) {
            // if line empty, skip it but keep order (do not randomize)
            // small pause to avoid tight loop
            await sleep(100);
            continue;
          }

          try {
            // immediate first send regardless of PER_THREAD_MIN_INTERVAL
            if (!state.firstSent) {
              await ent.broadcastText(txt);
              state.firstSent = true;
              state.lastSentAt = Date.now();
              const threadName = (state.threadObj && (state.threadObj.thread_title || (state.threadObj.users && state.threadObj.users[0] && state.threadObj.users[0].username))) || threadId;
              boxedSentLog(threadName, txt);
              // after first send wait delaySec + jitter
              const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
              await sleep(Math.max(0, state.delay * 1000) + jitter);
              continue;
            }

            // subsequent sends respect per-thread min interval + jitter
            const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
            const waitMs = Math.max(PER_THREAD_MIN_INTERVAL, state.delay * 1000) + jitter;
            const sinceLast = Date.now() - (state.lastSentAt || 0);
            if (sinceLast < waitMs) {
              await sleep(waitMs - sinceLast);
            }

            await ent.broadcastText(txt);
            state.lastSentAt = Date.now();
            state.backoffMultiplier = 1;
            const threadName2 = (state.threadObj && (state.threadObj.thread_title || (state.threadObj.users && state.threadObj.users[0] && state.threadObj.users[0].username))) || threadId;
            boxedSentLog(threadName2, txt);
            await sleep(200 + Math.floor(Math.random() * 400));
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            console.log(chalk.red(`[error send] ${threadId}: ${msg}`));
            if (err && err.statusCode === 429) {
              console.log(chalk.red(`[rate] 429 detected. Backing off thread ${threadId}`));
              await sleep(Math.min(MAX_429_BACKOFF_MS, PER_THREAD_MIN_INTERVAL * 4));
            } else {
              await sleep(2000);
            }
          }
        }
        console.log(chalk.red(`[session] STOPPED on ${threadId}`));
        activeSessions.delete(threadId);
      }

      function stopSending(threadId) {
        const s = activeSessions.get(threadId);
        if (s) {
          s.running = false;
          console.log(chalk.red(`[session] /stop primit — oprire ${threadId}`));
        }
      }

      // Improved: robust owner verification and silent incoming handling
      async function processCommandFrom(threadId, fromUserId, text) {
        try {
          if (!text) return;
          if (!fromUserId) return;

          // Normalize id/username -> numeric id where possible
          let candidate = String(fromUserId).trim();

          // If exact match allowed already, accept quickly
          if (allowedOwnerIds.has(candidate)) {
            // proceed
          } else {
            // Try to resolve username -> id if candidate contains non-digits
            try {
              if (!/^\d+$/.test(candidate)) {
                // assume username -> searchExact
                const ui = await ig.user.searchExact(candidate).catch(()=>null);
                if (ui && (ui.pk || ui.id)) {
                  candidate = String(ui.pk || ui.id);
                }
              } else {
                // candidate is numeric id string; try to fetch info to confirm
                const ui2 = await ig.user.info(candidate).catch(()=>null);
                if (ui2 && (ui2.pk || ui2.pk === 0 || ui2.id || ui2.username)) {
                  candidate = String(ui2.pk || ui2.id || candidate);
                }
              }
            } catch (e) {
              // ignore resolution errors
            }
          }

          // Final check: is candidate an allowed owner id?
          if (!allowedOwnerIds.has(candidate)) {
            // Not owner — do NOT log incoming message or reason (silent)
            return;
          }

          // At this point we know command originates from owner — parse and execute
          const trimmed = String(text).trim();
          const startDelay = parseStartCmdLocal(trimmed);
          if (startDelay !== null) {
            // Start sending
            console.log(chalk.red(`[cmd] Owner command received — starting on thread ${threadId} (delay ${startDelay}s)`));
            startSending(threadId, startDelay).catch(e => console.log(chalk.red('[startSending] err:'), e && e.message ? e.message : e));
            return;
          }
          if (/^\/stop$/i.test(trimmed)) {
            console.log(chalk.red(`[cmd] Owner command received — stopping thread ${threadId}`));
            stopSending(threadId);
            return;
          }
          // Unknown owner command: ignore silently
        } catch (e) {
          // Keep silent about incoming messages; log errors only if unexpected
          console.log(chalk.red('[processCommandFrom] unexpected error:'), e && e.message ? e.message : e);
        }
      }

      // Polling fallback for commands (robust: use canonical threadId keys)
      let pollingIntervalRef = null;
      let reconnectAttempts = 0;

      // Helper: attempt to extract a (from,text,id) triple from different shapes of top item
      async function extractFromTopOrThread(igClient, t, canonicalId) {
        // Try top-level item first
        try {
          const candidateTops = [];
          if (t.items && Array.isArray(t.items) && t.items.length) candidateTops.push(t.items[0]);
          if (t.last_permanent_item) candidateTops.push(t.last_permanent_item);
          if (t.last_activity_at && t.last_activity_at_item) candidateTops.push(t.last_activity_at_item);
          if (t.last_item) candidateTops.push(t.last_item);
          // push raw t in case it contains nested text fields
          candidateTops.push(t);

          for (const top of candidateTops) {
            if (!top) continue;
            let text = extractTextFromTopItem(top);
            let from = extractFromUserIdFromTopItem(top);
            if (text && from) return { text, from };
            // try nested shapes
            const nested = top.item || top.message || top.message_data || top.message_preview || null;
            if (nested) {
              const nt = extractTextFromTopItem(nested);
              const nf = extractFromUserIdFromTopItem(nested) || extractFromUserIdFromTopItem(top);
              if (nt && nf) return { text: nt, from: nf };
            }
          }
        } catch (e) {
          // ignore
        }

        // If nothing found, fetch thread content as fallback
        try {
          const fetched = await fetchLatestTextFromThread(igClient, canonicalId);
          if (fetched && fetched.text && fetched.from) return { text: fetched.text, from: fetched.from };
        } catch (e) {
          // ignore
        }
        return null;
      }

      async function startPollingLoop() {
        const lastSeen = new Map();
        try {
          const initial = await ig.feed.directInbox().request();
          const threads = initial.inbox_threads || initial.threads || (initial.inbox && initial.inbox.threads) || [];
          for (const t of threads) {
            const canonicalId = t.thread_id || t.threadId || t.id || null;
            // best-effort compute topId from multiple places
            let top = null;
            if (t.items && t.items[0]) top = t.items[0];
            else if (t.last_permanent_item) top = t.last_permanent_item;
            else top = t;
            const topId = (top && (top.item_id || top.id || top.client_context || String(top.timestamp || top.created_at || ''))) || null;
            if (canonicalId && topId) lastSeen.set(String(canonicalId), String(topId));
          }
        } catch (e) {}
        pollingIntervalRef = setInterval(async () => {
          try {
            const inbox = await ig.feed.directInbox().request();
            const threads = inbox.inbox_threads || inbox.threads || (inbox.inbox && inbox.inbox.threads) || [];
            for (const t of threads) {
              try {
                const canonicalId = t.thread_id || t.threadId || t.id || null;
                if (!canonicalId) continue;
                // pick a candidate top item intelligently
                let top = null;
                if (t.items && t.items[0]) top = t.items[0];
                else if (t.last_permanent_item) top = t.last_permanent_item;
                else top = t;
                const topId = (top && (top.item_id || top.id || top.client_context || String(top.timestamp || top.created_at || ''))) || null;
                const key = String(canonicalId);
                if (!topId) {
                  // If we cannot determine a topId, still attempt to extract commands by fetching latest thread
                  const fetched = await extractFromTopOrThread(ig, t, key);
                  if (fetched && fetched.text) {
                    // We still need to avoid processing same message repeatedly; use fetched.text hash + timestamp fallback
                    const fingerprint = String((topId || '') + '|' + (fetched.text || '').slice(0,120));
                    if (!lastSeen.get(key) || lastSeen.get(key) !== fingerprint) {
                      lastSeen.set(key, fingerprint);
                      await processCommandFrom(key, String(fetched.from), String(fetched.text));
                    }
                  }
                  continue;
                }

                if (!lastSeen.get(key) || lastSeen.get(key) !== String(topId)) {
                  // new item detected
                  lastSeen.set(key, String(topId));
                  // attempt to extract from the top item or fallback to thread fetch
                  const extracted = await extractFromTopOrThread(ig, t, key);
                  if (!extracted || !extracted.text) {
                    // no text found — skip silently
                    continue;
                  }
                  // process command but remain silent for non-owner or non-command
                  await processCommandFrom(key, String(extracted.from), String(extracted.text));
                }
              } catch (e) {
                // ignore per-thread errors silently
              }
            }
            reconnectAttempts = 0;
          } catch (err) {
            reconnectAttempts++;
            const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
            // Log minimal polling error (not message content)
            console.log(chalk.red(`[polling] Error fetching inbox, backing off for ${delay}ms...`));
            if (pollingIntervalRef) clearInterval(pollingIntervalRef);
            setTimeout(() => { startPollingLoop().catch(()=>{}); }, delay).unref();
          }
        }, POLLING_INTERVAL_MS);
      }

      // ensure sessionid attempt (best-effort)
      async function ensureSessionIdPresent(igClient) {
        const start = Date.now();
        while (Date.now() - start < SESSIONID_WAIT_MAX_MS) {
          try {
            const serialized = await igClient.state.serialize();
            const sid = findSessionId(serialized);
            if (sid) {
              await fs.writeFile(SESSION_FILE, JSON.stringify(serialized, null, 2), 'utf8');
              console.log(chalk.red('[sessionid] Found sessionid in serialized state'));
              return true;
            }
          } catch (e) {}
          await sleep(SESSIONID_WAIT_STEP_MS);
        }
        return false;
      }
      const sidFound = await ensureSessionIdPresent(ig).catch(()=>false);
      if (!sidFound) {
        console.log(chalk.red('[sessionid] sessionid not found in state after wait — continuing with polling fallback'));
      }
      console.log(chalk.red('[polling] Using polling-only mode — checking inbox every few seconds for owner commands'));
      await startPollingLoop();

      console.log(chalk.red('\nBot pornit. Ascult comenzi (/startN, /stop).'));
      console.log(chalk.red('Exemplu: /start1  -> spam cu delay 1s; /stop -> oprește în acel chat.'));
      console.log(chalk.red('Owner-only: comenzile funcționează doar de la owner (salvat în owner.json).'));
      console.log(chalk.red('Oprește scriptul cu Ctrl+C când vrei.\n'));

      // anti-crash & graceful shutdown
      process.on('uncaughtException', async (err) => {
        console.error(chalk.red('[uncaughtException]'), err && err.stack ? err.stack : err);
        try { await saveSession(ig); } catch {}
      });
      process.on('unhandledRejection', async (reason) => {
        console.error(chalk.red('[unhandledRejection]'), reason && reason.stack ? reason.stack : reason);
        try { await saveSession(ig); } catch {}
      });
      process.on('SIGINT', async () => {
        console.log(chalk.red('\nShutdown initiated... saving session and stopping...'));
        if (pollingIntervalRef) clearInterval(pollingIntervalRef);
        for (const [k, v] of activeSessions.entries()) { try { v.running = false; } catch {} }
        try { await saveSession(ig); } catch {}
        process.exit(0);
      });
      process.stdin.resume();
      return;
    }

    // Branch: user picked "2" (no commands). List threads -> select -> send until Ctrl+C.
    console.log(chalk.red('\nAi ales FARA comenzi. Voi afișa grupurile/conversațiile disponibile. Alege ce thread-uri vrei să trimiți mesaje.\n'));
    let inbox;
    try {
      const resp = await ig.feed.directInbox().request();
      inbox = resp.inbox_threads || resp.threads || (resp.inbox && resp.inbox.threads) || [];
    } catch (e) {
      console.log(chalk.red('[polling] Eroare la fetch inbox:'), e && e.message ? e.message : e);
      inbox = [];
    }
    if (!Array.isArray(inbox) || inbox.length === 0) {
      console.log(chalk.red('Inbox gol sau nu s-au putut obține thread-urile. Ies.'));
      process.exit(1);
    }

    // display numbered list (ONLY names now)
    console.log(chalk.red('Lista thread-uri disponibile:'));
    inbox.forEach((t, i) => {
      console.log(chalk.red(displayThreadName(t, i + 1)));
    });

    const selection = readline.question('Selectează thread-urile prin index (ex: 1,2,5) sau range (1-3): ').trim();
    if (!selection) {
      console.log(chalk.red('Nu ai selectat nimic. Ies.'));
      process.exit(1);
    }

    // parse selection: support comma separated and ranges
    function parseSelection(sel, max) {
      const set = new Set();
      const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p.includes('-')) {
          const [a, b] = p.split('-').map(x => parseInt(x.trim(), 10));
          if (Number.isFinite(a) && Number.isFinite(b)) {
            const [lo, hi] = a <= b ? [a, b] : [b, a];
            for (let k = lo; k <= hi; k++) {
              if (k >= 1 && k <= max) set.add(k - 1);
            }
          }
        } else {
          const idx = parseInt(p, 10);
          if (Number.isFinite(idx) && idx >= 1 && idx <= max) set.add(idx - 1);
        }
      }
      return Array.from(set).sort((a,b)=>a-b);
    }

    const indices = parseSelection(selection, inbox.length);
    if (!indices.length) {
      console.log(chalk.red('Nu am identificat indexuri valide. Ies.'));
      process.exit(1);
    }
    const chosenThreads = indices.map(i => inbox[i]).filter(Boolean);
    console.log(chalk.red(`Ai selectat ${chosenThreads.length} thread(s).`));

    // Ask text path and delay seconds
    let textPath = readline.question('Enter your text path here (ex: /storage/emulated/0/mesaje.txt): ').trim();
    if (!fs.existsSync(textPath)) {
      console.log(chalk.red('Fișierul nu exista:'), textPath);
      process.exit(1);
    }
    const raw = await fs.readFile(textPath, 'utf8');

    // *** IMPORTANT CHANGE HERE TOO: preserve the lines EXACT order in the file ***
    const lines = raw.split(/\r?\n/);
    if (!Array.isArray(lines) || lines.length === 0) {
      console.log(chalk.red('Fișierul text gol. Ies.'));
      process.exit(1);
    }
    console.log(chalk.red(`Fișier incarcat — ${lines.length} linii (incluzand eventuale linii goale).`));

    let delaySeconds = Number(readline.question('Enter delay seconds between messages per thread (ex: 2): ').trim() || '2');
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0.1) delaySeconds = 2;
    console.log(chalk.red(`Delay set to ${delaySeconds}s per message per thread (plus jitter).`));

    // Build sendState with pre-created entities and check validity
    const sendState = chosenThreads.map(t => {
      const threadId = t.thread_id || t.threadId || t.id || null;
      const ent = threadId ? makeThreadEntity(threadId) : null;
      if (!ent) {
        console.log(chalk.red(`[warn] Nu pot crea entity pentru thread: ${threadId} — îl voi sări.`));
      }
      return {
        threadObj: t,
        threadId,
        ent,
        idx: 0,
        lastSentAt: 0,
        backoffMultiplier: 1,
        firstSent: false
      };
    }).filter(s => s.threadId && s.ent);

    if (!sendState.length) {
      console.log(chalk.red('Niciun thread valid găsit după filtrare. Ies.'));
      process.exit(1);
    }

    console.log(chalk.red('\nPornesc trimiterea în buclă către thread-urile selectate. Oprește cu Ctrl+C.\n'));

    // ensure sessionid best-effort
    async function ensureSessionIdPresent(igClient) {
      const start = Date.now();
      while (Date.now() - start < SESSIONID_WAIT_MAX_MS) {
        try {
          const serialized = await igClient.state.serialize();
          const sid = findSessionId(serialized);
          if (sid) {
            await fs.writeFile(SESSION_FILE, JSON.stringify(serialized, null, 2), 'utf8');
            console.log(chalk.red('[sessionid] Found sessionid in serialized state'));
            return true;
          }
        } catch (e) {}
        await sleep(SESSIONID_WAIT_STEP_MS);
      }
      return false;
    }
    const sidFound = await ensureSessionIdPresent(ig).catch(()=>false);
    if (!sidFound) {
      console.log(chalk.red('[sessionid] sessionid not found in state after wait — proceeding (polling-only).'));
    }

    // NEW: per-thread sending loops (reliable + non-blocking)
    let globalLastSend = Date.now() - GLOBAL_MIN_SEND_INTERVAL - 50; // allow immediate first send
    let globalBackoffUntil = 0;
    let stopped = false;

    async function perThreadLoop(state) {
      const ent = state.ent;
      const threadId = state.threadId;
      // allow immediate first send by ensuring lastSentAt is sufficiently in the past
      state.lastSentAt = 0;

      while (!stopped) {
        try {
          const nowMs = Date.now();

          // respect global backoff
          if (globalBackoffUntil > nowMs) {
            const remaining = globalBackoffUntil - nowMs;
            await sleep(Math.min(remaining, 2000) + Math.floor(Math.random() * 400));
            continue;
          }

          // compute minWait: first send uses user's delaySeconds (so can be smaller than PER_THREAD_MIN_INTERVAL)
          const isFirst = !state.firstSent && state.idx === 0;
          const desiredInterval = Math.max(100, Math.floor(delaySeconds * 1000)); // at least 100ms
          const minWait = isFirst ? desiredInterval : Math.max(PER_THREAD_MIN_INTERVAL, desiredInterval);

          const sinceLast = nowMs - (state.lastSentAt || 0);
          if (sinceLast < minWait) {
            const toWait = Math.max(50, minWait - sinceLast);
            await sleep(toWait + Math.floor(Math.random() * JITTER_MAX_MS));
            continue;
          }

          // enforce global spacing
          const sinceGlobal = nowMs - globalLastSend;
          if (sinceGlobal < GLOBAL_MIN_SEND_INTERVAL) {
            await sleep(GLOBAL_MIN_SEND_INTERVAL - sinceGlobal + Math.floor(Math.random() * 200));
            continue;
          }

          // ** Deterministic line selection: get next non-empty line in order **
          const { line: txt, nextIdx } = getNextLine(lines, state);
          state.idx = nextIdx;

          if (!txt || txt.replace(/\s/g, '').length === 0) {
            // skip empty lines (preserve order)
            await sleep(100);
            continue;
          }

          // Debug log: next send
          console.log(chalk.red(`[next send] ${now()} -> ${threadId} (idx ${state.idx})`));

          await ent.broadcastText(txt);

          state.lastSentAt = Date.now();
          globalLastSend = state.lastSentAt;
          state.idx++;
          state.firstSent = true;
          state.backoffMultiplier = 1; // reset on success

          // determine readable name for the thread for logging
          const threadName = (state.threadObj && (state.threadObj.thread_title || (state.threadObj.users && state.threadObj.users[0] && state.threadObj.users[0].username))) || threadId;
          boxedSentLog(threadName, txt);

          // small jitter after success
          await sleep(300 + Math.floor(Math.random() * JITTER_MAX_MS));

        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          console.log(chalk.red(`[error send] ${state.threadId}: ${msg}`));
          if (err && err.statusCode === 429) {
            const backoff = Math.min(MAX_429_BACKOFF_MS, PER_THREAD_MIN_INTERVAL * (state.backoffMultiplier || 1) * 4);
            globalBackoffUntil = Date.now() + backoff;
            state.backoffMultiplier = (state.backoffMultiplier || 1) * 2;
            console.log(chalk.red(`[rate] 429 detected — backing off ${backoff}ms globally and for thread ${state.threadId}`));
            await sleep(backoff + 200);
          } else {
            state.backoffMultiplier = Math.min(8, (state.backoffMultiplier || 1) * 2);
            const localDelay = Math.min(30_000, PER_THREAD_MIN_INTERVAL * state.backoffMultiplier);
            console.log(chalk.red(`[rate] Error fallback — delaying thread ${state.threadId} for ${localDelay}ms`));
            // nudge lastSentAt so next iteration respects min interval
            state.lastSentAt = Date.now() - (PER_THREAD_MIN_INTERVAL - Math.min(PER_THREAD_MIN_INTERVAL, localDelay));
            await sleep(localDelay + Math.floor(Math.random() * 400));
          }
        }
      }
      console.log(chalk.red(`[send-loop] thread loop stopped for ${state.threadId}`));
    }

    // start all per-thread loops concurrently (staggered)
    for (const s of sendState) {
      perThreadLoop(s).catch(e => console.log(chalk.red('[send-loop] unhandled thread error:'), e && e.message ? e.message : e));
      await sleep(100 + Math.floor(Math.random() * 300));
    }

    // keep process alive and handle Ctrl+C gracefully
    process.on('SIGINT', async () => {
      console.log(chalk.red('\nShutdown requested (Ctrl+C). Stopping sends and saving session...'));
      stopped = true;
      await sleep(800);
      try { await saveSession(ig); } catch (e) {}
      process.exit(0);
    });

    // anti-crash
    process.on('uncaughtException', async (err) => {
      console.error(chalk.red('[uncaughtException]'), err && err.stack ? err.stack : err);
      try { await saveSession(ig); } catch {}
    });
    process.on('unhandledRejection', async (reason) => {
      console.error(chalk.red('[unhandledRejection]'), reason && reason.stack ? reason.stack : reason);
      try { await saveSession(ig); } catch {}
    });

    process.stdin.resume();

  } catch (err) {
    console.error(chalk.red('Eroare fatala:'), err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();

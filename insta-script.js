/**
 * index.js
 * Instagram Bot Gyovanny - converted to nodejs-insta-private-api (best-effort)
 *
 * Notes:
 *  - Uses: nodejs-insta-private-api (README-based API calls)
 *  - Preserves: /startN, /stop, polling + realtime attempt, session save/load, line-order deterministic reading
 *  - Additions: Utils import from nodejs-insta-private-api/dist/utils
 */

const { IgApiClient } = require('nodejs-insta-private-api');
const Utils = require('nodejs-insta-private-api/dist/utils');
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

// ---------- session helpers using nodejs-insta-private-api ----------
async function saveSession(ig) {
  try {
    if (!ig) return;
    // ig.saveSession returns a plain object representing session
    const sessionObj = await ig.saveSession();
    if (!sessionObj) return;
    await fs.writeFile(SESSION_FILE, JSON.stringify(sessionObj, null, 2), 'utf8');
    console.log(chalk.red(`[session] Saved session to ${SESSION_FILE}`));
  } catch (err) {
    console.log(chalk.red('[session] Failed to save session:'), err && err.message ? err.message : err);
  }
}

async function tryLoadSessionOnly(ig) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf8');
    const session = JSON.parse(raw);
    await ig.loadSession(session);
    // validate
    const valid = typeof ig.isSessionValid === 'function' ? await ig.isSessionValid().catch(() => false) : true;
    if (!valid) throw new Error('session invalid according to ig.isSessionValid');
    console.log(chalk.red(`[session] Loaded session from ${SESSION_FILE}`));
    return true;
  } catch (err) {
    console.log(chalk.red('[session] Failed to load session:'), err && err.message ? err.message : err);
    return false;
  }
}

// ---------- owner persistence ----------
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

// ---------- util functions (same as original) ----------
function parseStartCmd(text) {
  if (!text) return null;
  const m = text.trim().match(/^\/start(\d*\.?\d*)$/i);
  if (!m) return null;
  const n = m[1] ? parseFloat(m[1]) : 1;
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

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

// helpers for message extraction (copied/adapted from your version)
function extractFromUserIdFromTopItem(top) {
  try {
    if (!top) return null;
    if (top.user_id) return String(top.user_id);
    if (top.user && (top.user.pk || top.user.id)) return String(top.user.pk || top.user.id);
    if (top.sender_id) return String(top.sender_id);
    if (top._sender && (top._sender.pk || top._sender.id)) return String(top._sender.pk || top._sender.id);
    if (top.item && top.item.user_id) return String(top.item.user_id);
    if (top.user_id_str) return String(top.user_id_str);
    if (top.user && top.user.pk) return String(top.user.pk);
    if (top.item && top.item.user && (top.item.user.pk || top.item.user.id)) return String(top.item.user.pk || top.item.user.id);
    // nodejs-insta-private-api thread item variations:
    if (top.user && top.user.pk) return String(top.user.pk);
    if (top.sender && top.sender.pk) return String(top.sender.pk);
    return null;
  } catch (e) { return null; }
}
function extractTextFromTopItem(top) {
  try {
    if (!top) return null;
    if (typeof top.text === 'string' && top.text.trim()) return top.text.trim();
    if (typeof top.message === 'string' && top.message.trim()) return top.message.trim();
    if (typeof top.text_body === 'string' && top.text_body.trim()) return top.text_body.trim();
    if (typeof top.caption === 'string' && top.caption.trim()) return top.caption.trim();
    if (typeof top.story_share_text === 'string' && top.story_share_text.trim()) return top.story_share_text.trim();
    if (Array.isArray(top.texts) && top.texts.length) {
      for (const t of top.texts) {
        if (typeof t === 'string' && t.trim()) return t.trim();
        if (t && typeof t === 'object' && typeof t.text === 'string' && t.text.trim()) return t.text.trim();
      }
    }
    if (top.item && typeof top.item === 'object') {
      if (typeof top.item.text === 'string' && top.item.text.trim()) return top.item.text.trim();
      if (typeof top.item.message === 'string' && top.item.message.trim()) return top.item.message.trim();
      if (top.item && top.item.message && typeof top.item.message.text === 'string' && top.item.message.text.trim()) return top.item.message.text.trim();
    }
    if (top.message && typeof top.message === 'object') {
      if (typeof top.message.text === 'string' && top.message.text.trim()) return top.message.text.trim();
      if (typeof top.message.textPreview === 'string' && top.message.textPreview.trim()) return top.message.textPreview.trim();
    }
    for (const k of Object.keys(top)) {
      if (typeof top[k] === 'string' && top[k].length > 0 && k.toLowerCase().includes('text')) return top[k].trim();
      if (typeof top[k] === 'string' && top[k].length > 0 && (k.toLowerCase().includes('message') || k.toLowerCase().includes('body'))) return top[k].trim();
    }
    return null;
  } catch (e) { return null; }
}

// boxed red log
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
 * Deterministic line retrieval preserving order
 */
function getNextLine(lines, state) {
  if (!Array.isArray(lines) || lines.length === 0) {
    state.idx = 0;
    return { line: '', nextIdx: 0 };
  }
  const total = lines.length;
  let start = (typeof state.idx === 'number' ? state.idx : 0) % total;
  if (start < 0) start += total;
  for (let attempt = 0; attempt < total; attempt++) {
    const current = start % total;
    const rawLine = lines[current];
    const isNonEmpty = typeof rawLine === 'string' && rawLine.replace(/\s/g, '').length > 0;
    if (isNonEmpty) {
      const nextIdx = (current + 1) % total;
      return { line: rawLine, nextIdx };
    }
    start = (start + 1) % total;
  }
  const nextIdx = (state.idx + 1) % total;
  return { line: '', nextIdx };
}

// ---------- makeThreadEntity wrapper for nodejs lib ----------
function makeThreadEntityFactory(ig) {
  // Returns a factory that given threadId returns object with broadcastText(txt)
  return function makeThreadEntity(threadIdOrUsers) {
    return {
      broadcastText: async function (txt) {
        // Prefer sendToGroup when threadId likely a thread id
        try {
          // If looks like a thread id (contains 'thread' or is long alphanumeric), use sendToGroup
          if (typeof threadIdOrUsers === 'string') {
            const tid = threadIdOrUsers;
            // Try sendToGroup (if it exists)
            if (typeof ig.dm.sendToGroup === 'function') {
              try {
                await ig.dm.sendToGroup({ threadId: tid, message: txt });
                return;
              } catch (e) {
                // fallthrough to try dm.send
              }
            }
            // fallback: try dm.send to username
            if (typeof ig.dm.send === 'function') {
              await ig.dm.send({ to: tid, message: txt });
              return;
            }
          }
          // if threadIdOrUsers is array or object
          if (Array.isArray(threadIdOrUsers)) {
            // attempt to create group and send
            if (typeof ig.direct !== 'undefined' && typeof ig.direct.createGroupThread === 'function') {
              const group = await ig.direct.createGroupThread(threadIdOrUsers, 'Group');
              if (group && group.thread_id && typeof ig.dm.sendToGroup === 'function') {
                await ig.dm.sendToGroup({ threadId: group.thread_id, message: txt });
                return;
              }
            }
            // fallback: send to first username
            if (threadIdOrUsers.length && typeof ig.dm.send === 'function') {
              await ig.dm.send({ to: threadIdOrUsers[0], message: txt });
              return;
            }
          }
          throw new Error('No suitable send method available for thread entity');
        } catch (e) {
          // rethrow to be handled by caller
          throw e;
        }
      }
    };
  };
}

// ---------- fetch latest text from thread using nodejs methods ----------
async function fetchLatestTextFromThreadNode(igClient, threadId) {
  try {
    // prefer ig.dm.getThread
    if (typeof igClient.dm.getThread === 'function') {
      const resp = await igClient.dm.getThread(threadId);
      // resp.thread.items?
      const thread = resp && (resp.thread || resp);
      const items = (thread && (thread.items || thread.thread?.items || thread.thread_items)) || [];
      // Try newest-first
      const arr = Array.isArray(items) ? items.slice().reverse() : [];
      const check = arr.length ? arr : Array.isArray(items) ? items : [];
      for (const it of check.reverse ? check.reverse() : check) {
        const top = it;
        const text = extractTextFromTopItem(top);
        const from = extractFromUserIdFromTopItem(top);
        if (text && from) return { text, from };
        const nested = it.item || it.message || null;
        if (nested) {
          const t = extractTextFromTopItem(nested);
          const f = extractFromUserIdFromTopItem(nested) || extractFromUserIdFromTopItem(it);
          if (t && f) return { text: t, from: f };
        }
      }
    }
    // fallback: try ig.dm.getThread or ig.dm.getInbox and search
    return null;
  } catch (e) {
    return null;
  }
}

// ---------- main ----------
(async () => {
  try {
    const ig = new IgApiClient();
    const makeThreadEntity = makeThreadEntityFactory(ig);

    // Try to auto-load session
    let hadSession = false;
    try {
      hadSession = await tryLoadSessionOnly(ig);
    } catch (e) { hadSession = false; }

    let username = null;
    let password = null;

    if (!hadSession) {
      // prompt credentials and login using nodejs-insta-private-api style
      username = readline.question('Enter your Instagram username: ').trim();
      password = readline.question('Enter your Instagram password: ', { hideEchoBack: true }).trim();
      try {
        await ig.login({ username, password }).catch(async (err) => { throw err; });
        console.log(chalk.red(`✅ Logged in as ${username}`));
        await saveSession(ig);
        hadSession = true;
      } catch (err) {
        console.log(chalk.red('[login] Login failed:'), err && err.message ? err.message : err);
        process.exit(1);
      }
    } else {
      // session loaded: validate with ig.isSessionValid()
      try {
        const valid = (typeof ig.isSessionValid === 'function') ? await ig.isSessionValid().catch(()=>false) : true;
        if (!valid) throw new Error('Session invalid');
        // best-effort try to get username from session or ask user (fallback)
        try {
          // attempt to get 'me' via account.currentUser if exists
          if (typeof ig.account !== 'undefined' && typeof ig.account.currentUser === 'function') {
            const me = await ig.account.currentUser().catch(()=>null);
            if (me && me.username) username = me.username;
          }
        } catch (e) {}
        console.log(chalk.red(`✅ Session valid (loaded)`));
      } catch (err) {
        console.log(chalk.red('[session] Session invalid on validation, will login with credentials...'));
        username = readline.question('Enter your Instagram username: ').trim();
        password = readline.question('Enter your Instagram password: ', { hideEchoBack: true }).trim();
        try {
          await ig.login({ username, password });
          console.log(chalk.red(`✅ Logged in as ${username}`));
          await saveSession(ig);
          hadSession = true;
        } catch (e) {
          console.log(chalk.red('[login] Login failed:'), e && e.message ? e.message : e);
          process.exit(1);
        }
      }
    }

    // autosave periodically
    setInterval(() => saveSession(ig), AUTO_SAVE_INTERVAL_MS).unref();

    // OWNER flow
    let ownerObj = await loadOwner();
    let allowedOwnerIds = new Set();
    if (ownerObj && (ownerObj.ownerId || ownerObj.ownerUsername)) {
      if (ownerObj.ownerId) allowedOwnerIds.add(String(ownerObj.ownerId));
      if (ownerObj.ownerUsername) {
        try {
          // try to resolve username -> id via user.infoByUsername
          if (typeof ig.user.infoByUsername === 'function') {
            const info = await ig.user.infoByUsername(ownerObj.ownerUsername).catch(()=>null);
            if (info && (info.pk || info.id)) {
              allowedOwnerIds.add(String(info.pk || info.id));
              ownerObj.ownerId = String(info.pk || info.id);
              await saveOwner(ownerObj);
            }
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
        // try to get current user id via multiple fallbacks
        try {
          let me = null;
          if (typeof ig.account !== 'undefined' && typeof ig.account.currentUser === 'function') {
            me = await ig.account.currentUser().catch(()=>null);
          }
          if (!me && username) {
            // try infoByUsername
            me = await ig.user.infoByUsername(username).catch(()=>null);
          }
          if (me && (me.pk || me.id)) {
            const id = String(me.pk || me.id);
            const usernameResolved = me.username || username;
            ownerObj = { ownerId: id, ownerUsername: usernameResolved };
            allowedOwnerIds.add(id);
            await saveOwner(ownerObj);
            console.log(chalk.red(`[owner] Set owner to current account: ${usernameResolved} (${id})`));
          } else {
            console.log(chalk.red('[owner] Nu am putut determina ID-ul contului curent; te rog introdu username manual.'));
            const ownerUsername = readline.question('Introdu username-ul owner (ex: alt_user): ').trim();
            try {
              const info = await ig.user.infoByUsername(ownerUsername).catch(()=>null);
              if (info && (info.pk || info.id)) {
                const id = String(info.pk || info.id);
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
        } catch (e) {
          console.log(chalk.red('[owner] Eroare la setarea owner-ului din contul curent:'), e && e.message ? e.message : e);
        }
      } else {
        const ownerUsername = readline.question('Introdu username-ul owner (ex: alt_user): ').trim();
        try {
          const info = await ig.user.infoByUsername(ownerUsername).catch(()=>null);
          if (info && (info.pk || info.id)) {
            const id = String(info.pk || info.id);
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

    // Ensure fallback owner
    if (ownerObj && ownerObj.ownerId && allowedOwnerIds.size === 0) {
      allowedOwnerIds.add(String(ownerObj.ownerId));
    }
    if (allowedOwnerIds.size === 0) {
      try {
        let me = null;
        if (typeof ig.account !== 'undefined' && typeof ig.account.currentUser === 'function') {
          me = await ig.account.currentUser().catch(()=>null);
        }
        if (!me && username) me = await ig.user.infoByUsername(username).catch(()=>null);
        if (me && (me.pk || me.id)) {
          const id = String(me.pk || me.id);
          allowedOwnerIds.add(id);
          ownerObj = ownerObj || {};
          ownerObj.ownerId = id;
          ownerObj.ownerUsername = me.username || username;
          await saveOwner(ownerObj);
          console.log(chalk.red(`[owner] Fallback owner set to logged account: ${ownerObj.ownerUsername} (${id})`));
        }
      } catch (e) {
        console.log(chalk.red('[owner] Nu am putut seta owner fallback'));
      }
    }
    console.log(chalk.red(`[owner] Owner ID(s) permis(e): ${Array.from(allowedOwnerIds).join(', ')}`));

    // Now the commands choice
    console.log('\nVrei comenzi de /start și /stop?');
    console.log('1. da');
    console.log('2. nu');
    const want = readline.question('Alege (1 sau 2): ').trim();
    const wantCmd = want === '1';

    const activeSessions = new Map();

    if (wantCmd) {
      // Command-mode: load text lines preserving order
      let textPath = readline.question('Enter your text path here (ex: /storage/emulated/0/mesaje.txt): ').trim();
      if (!fs.existsSync(textPath)) {
        console.log(chalk.red('Fișierul nu exista:'), textPath);
        process.exit(1);
      }
      const raw = await fs.readFile(textPath, 'utf8');
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

        // try fetch thread for nice logs
        let threadObj = null;
        try {
          if (typeof ig.dm.getThread === 'function') {
            const threadResp = await ig.dm.getThread(threadId).catch(()=>null);
            threadObj = threadResp && (threadResp.thread || threadResp);
          }
        } catch (e) {}

        const state = { running: true, delay: Math.max(0, Number(delaySec) || 1), idx: 0, ent, firstSent: false, threadObj };
        activeSessions.set(threadId, state);
        console.log(chalk.red(`[session] START pe ${threadId} delay ${state.delay}s`));

        while (state.running) {
          const { line: txt, nextIdx } = getNextLine(lines, state);
          state.idx = nextIdx;
          if (!txt || txt.replace(/\s/g, '').length === 0) {
            await sleep(100);
            continue;
          }
          try {
            if (!state.firstSent) {
              await ent.broadcastText(txt);
              state.firstSent = true;
              state.lastSentAt = Date.now();
              const threadName = (state.threadObj && (state.threadObj.thread_title || (state.threadObj.users && state.threadObj.users[0] && state.threadObj.users[0].username))) || threadId;
              boxedSentLog(threadName, txt);
              const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
              await sleep(Math.max(0, state.delay * 1000) + jitter);
              continue;
            }
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
            if (err && (err.statusCode === 429 || (err.name && err.name.toLowerCase().includes('spam')))) {
              console.log(chalk.red(`[rate] 429/spam detected. Backing off thread ${threadId}`));
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

      // Process incoming commands from owner (owner id resolution robust)
      async function processCommandFrom(threadId, fromUserIdOrUsername, text) {
        try {
          if (!text) return;
          if (!fromUserIdOrUsername) return;
          let candidate = String(fromUserIdOrUsername).trim();
          if (!allowedOwnerIds.has(candidate)) {
            // try to resolve username -> id
            try {
              if (!/^\d+$/.test(candidate) && typeof ig.user.infoByUsername === 'function') {
                const ui = await ig.user.infoByUsername(candidate).catch(()=>null);
                if (ui && (ui.pk || ui.id)) candidate = String(ui.pk || ui.id);
              } else if (/^\d+$/.test(candidate) && typeof ig.user.info === 'function') {
                const ui2 = await ig.user.info(candidate).catch(()=>null);
                if (ui2 && (ui2.pk || ui2.id)) candidate = String(ui2.pk || ui2.id);
              }
            } catch (e) {}
          }
          if (!allowedOwnerIds.has(candidate)) return;
          const trimmed = String(text).trim();
          const startDelay = parseStartCmdLocal(trimmed);
          if (startDelay !== null) {
            console.log(chalk.red(`[cmd] Owner command received — starting on thread ${threadId} (delay ${startDelay}s)`));
            startSending(threadId, startDelay).catch(e => console.log(chalk.red('[startSending] err:'), e && e.message ? e.message : e));
            return;
          }
          if (/^\/stop$/i.test(trimmed)) {
            console.log(chalk.red(`[cmd] Owner command received — stopping thread ${threadId}`));
            stopSending(threadId);
            return;
          }
        } catch (e) {
          console.log(chalk.red('[processCommandFrom] unexpected error:'), e && e.message ? e.message : e);
        }
      }

      // Polling fallback
      let pollingIntervalRef = null;
      let reconnectAttempts = 0;

      async function extractFromTopOrThread(igClient, t, canonicalId) {
        try {
          const candidateTops = [];
          if (t.items && Array.isArray(t.items) && t.items.length) candidateTops.push(t.items[0]);
          if (t.last_permanent_item) candidateTops.push(t.last_permanent_item);
          if (t.last_activity_at && t.last_activity_at_item) candidateTops.push(t.last_activity_at_item);
          if (t.last_item) candidateTops.push(t.last_item);
          candidateTops.push(t);
          for (const top of candidateTops) {
            if (!top) continue;
            let text = extractTextFromTopItem(top);
            let from = extractFromUserIdFromTopItem(top);
            if (text && from) return { text, from };
            const nested = top.item || top.message || top.message_data || top.message_preview || null;
            if (nested) {
              const nt = extractTextFromTopItem(nested);
              const nf = extractFromUserIdFromTopItem(nested) || extractFromUserIdFromTopItem(top);
              if (nt && nf) return { text: nt, from: nf };
            }
          }
        } catch (e) {}
        try {
          const fetched = await fetchLatestTextFromThreadNode(igClient, canonicalId);
          if (fetched && fetched.text && fetched.from) return { text: fetched.text, from: fetched.from };
        } catch (e) {}
        return null;
      }

      async function startPollingLoop() {
        const lastSeen = new Map();
        try {
          const initial = (typeof ig.dm.getInbox === 'function') ? await ig.dm.getInbox().catch(()=>({ inbox: { threads: [] } })) : { inbox: { threads: [] } };
          const threads = initial && (initial.inbox && initial.inbox.threads) ? initial.inbox.threads : (initial.threads || []);
          for (const t of threads) {
            const canonicalId = t.thread_id || t.threadId || t.id || null;
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
            const inboxResp = (typeof ig.dm.getInbox === 'function') ? await ig.dm.getInbox().catch(()=>({ inbox: { threads: [] } })) : { inbox: { threads: [] } };
            const threads = inboxResp && (inboxResp.inbox && inboxResp.inbox.threads) ? inboxResp.inbox.threads : (inboxResp.threads || []);
            for (const t of threads) {
              try {
                const canonicalId = t.thread_id || t.threadId || t.id || null;
                if (!canonicalId) continue;
                let top = null;
                if (t.items && t.items[0]) top = t.items[0];
                else if (t.last_permanent_item) top = t.last_permanent_item;
                else top = t;
                const topId = (top && (top.item_id || top.id || top.client_context || String(top.timestamp || top.created_at || ''))) || null;
                const key = String(canonicalId);
                if (!topId) {
                  const fetched = await extractFromTopOrThread(ig, t, key);
                  if (fetched && fetched.text) {
                    const fingerprint = String((topId || '') + '|' + (fetched.text || '').slice(0,120));
                    if (!lastSeen.get(key) || lastSeen.get(key) !== fingerprint) {
                      lastSeen.set(key, fingerprint);
                      await processCommandFrom(key, String(fetched.from), String(fetched.text));
                    }
                  }
                  continue;
                }
                if (!lastSeen.get(key) || lastSeen.get(key) !== String(topId)) {
                  lastSeen.set(key, String(topId));
                  const extracted = await extractFromTopOrThread(ig, t, key);
                  if (!extracted || !extracted.text) {
                    continue;
                  }
                  await processCommandFrom(key, String(extracted.from), String(extracted.text));
                }
              } catch (e) {}
            }
            reconnectAttempts = 0;
          } catch (err) {
            reconnectAttempts++;
            const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
            console.log(chalk.red(`[polling] Error fetching inbox, backing off for ${delay}ms...`));
            if (pollingIntervalRef) clearInterval(pollingIntervalRef);
            setTimeout(() => { startPollingLoop().catch(()=>{}); }, delay).unref();
          }
        }, POLLING_INTERVAL_MS);
      }

      // Realtime attempt (best-effort) using nodejs-insta-private-api
      let realtimeTried = false;
      try {
        if (typeof ig.connectRealtime === 'function') {
          realtimeTried = true;
          await ig.connectRealtime();
          if (ig.realtime && ig.realtime.on) {
            ig.realtime.on('messageSync', async (data) => {
              // messageSync payload format varies; try robust extraction
              try {
                // attempt to find message text and sender from data
                // many shapes: data.messages, data.payloads, data.syncs etc.
                // We'll try few shapes conservatively
                let text = null;
                let from = null;
                if (data && data.messages && Array.isArray(data.messages) && data.messages.length) {
                  const m = data.messages[0];
                  text = extractTextFromTopItem(m) || (m.text || m.message || null);
                  from = extractFromUserIdFromTopItem(m) || m.user_id || m.sender_id || (m.user && (m.user.pk || m.user.id)) || null;
                }
                if (!text && data && data.payload) {
                  text = extractTextFromTopItem(data.payload) || data.payload.text || null;
                  from = extractFromUserIdFromTopItem(data.payload) || data.payload.sender || null;
                }
                // if we have both, process
                if (text && from) await processCommandFrom(String(data.threadId || data.thread || data.thread_id || 'unknown'), String(from), String(text));
              } catch (e) {}
            });
            // additional events logged for debug
            ig.realtime.on('graphqlMessage', (d)=>{ /* optional debug */ });
            ig.realtime.on('pubsubMessage', (d)=>{ /* optional debug */ });
          }
        }
      } catch (e) {
        // ignore realtime errors and fall back to polling
      }

      // If realtime not connected, go to polling
      const realtimeConnected = (typeof ig.isRealtimeConnected === 'function') ? ig.isRealtimeConnected() : false;
      if (!realtimeConnected) {
        console.log(chalk.red('[polling] Using polling-only mode — checking inbox every few seconds for owner commands'));
        await startPollingLoop();
      } else {
        // Even if realtime is connected, still start a light polling as fallback
        try { await startPollingLoop().catch(()=>{}); } catch(e) {}
        console.log(chalk.red('[mqtt] Realtime connected — also running polling fallback'));
      }

      console.log(chalk.red('\nBot pornit. Ascult comenzi (/startN, /stop).'));
      console.log(chalk.red('Exemplu: /start1  -> spam cu delay 1s; /stop -> oprește în acel chat.'));
      console.log(chalk.red('Owner-only: comenzile funcționează doar de la owner (salvat în owner.json).'));
      console.log(chalk.red('Oprește scriptul cu Ctrl+C când vrei.\n'));

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
        if (typeof ig.disconnectRealtime === 'function') try { await ig.disconnectRealtime(); } catch {}
        process.exit(0);
      });
      process.stdin.resume();
      return;
    }

    // Branch no-commands: list threads and send to selected threads (preserve order)
    console.log(chalk.red('\nAi ales FARA comenzi. Voi afișa grupurile/conversațiile disponibile. Alege ce thread-uri vrei să trimiți mesaje.\n'));
    let inbox = [];
    try {
      const resp = (typeof ig.dm.getInbox === 'function') ? await ig.dm.getInbox().catch(()=>({ inbox: { threads: [] } })) : { inbox: { threads: [] } };
      inbox = resp && (resp.inbox && resp.inbox.threads) ? resp.inbox.threads : (resp.threads || []);
    } catch (e) {
      console.log(chalk.red('[polling] Eroare la fetch inbox:'), e && e.message ? e.message : e);
      inbox = [];
    }
    if (!Array.isArray(inbox) || inbox.length === 0) {
      console.log(chalk.red('Inbox gol sau nu s-au putut obține thread-urile. Ies.'));
      process.exit(1);
    }

    console.log(chalk.red('Lista thread-uri disponibile:'));
    inbox.forEach((t, i) => {
      // display name heuristics
      const display = (t.thread_title && String(t.thread_title).trim()) || (t.users && t.users[0] && (t.users[0].username || t.users[0].pk)) || (t.thread_id || t.id) || '(no title)';
      console.log(chalk.red(`${String(i+1).padStart(2,' ')}. ${display}`));
    });

    const selection = readline.question('Selectează thread-urile prin index (ex: 1,2,5) sau range (1-3): ').trim();
    if (!selection) {
      console.log(chalk.red('Nu ai selectat nimic. Ies.'));
      process.exit(1);
    }
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
    const lines = raw.split(/\r?\n/);
    if (!Array.isArray(lines) || lines.length === 0) {
      console.log(chalk.red('Fișierul text gol. Ies.'));
      process.exit(1);
    }
    console.log(chalk.red(`Fișier incarcat — ${lines.length} linii (incluzand eventuale linii goale).`));

    let delaySeconds = Number(readline.question('Enter delay seconds between messages per thread (ex: 2): ').trim() || '2');
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0.1) delaySeconds = 2;
    console.log(chalk.red(`Delay set to ${delaySeconds}s per message per thread (plus jitter).`));

    // Build sendState
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

    // ensure sessionid best-effort: try ig.saveSession() content search if available
    async function ensureSessionIdPresent(igClient) {
      const start = Date.now();
      while (Date.now() - start < SESSIONID_WAIT_MAX_MS) {
        try {
          const sessionObj = await igClient.saveSession().catch(()=>null);
          const sid = findSessionId(sessionObj);
          if (sid) {
            await fs.writeFile(SESSION_FILE, JSON.stringify(sessionObj, null, 2), 'utf8');
            console.log(chalk.red('[sessionid] Found sessionid in saved session'));
            return true;
          }
        } catch (e) {}
        await sleep(SESSIONID_WAIT_STEP_MS);
      }
      return false;
    }
    const sidFound = await ensureSessionIdPresent(ig).catch(()=>false);
    if (!sidFound) {
      console.log(chalk.red('[sessionid] sessionid not found in saved session after wait — proceeding (polling-only).'));
    }

    // per-thread loops
    let globalLastSend = Date.now() - GLOBAL_MIN_SEND_INTERVAL - 50;
    let globalBackoffUntil = 0;
    let stopped = false;

    async function perThreadLoop(state) {
      const ent = state.ent;
      const threadId = state.threadId;
      state.lastSentAt = 0;

      while (!stopped) {
        try {
          const nowMs = Date.now();
          if (globalBackoffUntil > nowMs) {
            const remaining = globalBackoffUntil - nowMs;
            await sleep(Math.min(remaining, 2000) + Math.floor(Math.random() * 400));
            continue;
          }
          const isFirst = !state.firstSent && state.idx === 0;
          const desiredInterval = Math.max(100, Math.floor(delaySeconds * 1000));
          const minWait = isFirst ? desiredInterval : Math.max(PER_THREAD_MIN_INTERVAL, desiredInterval);
          const sinceLast = nowMs - (state.lastSentAt || 0);
          if (sinceLast < minWait) {
            const toWait = Math.max(50, minWait - sinceLast);
            await sleep(toWait + Math.floor(Math.random() * JITTER_MAX_MS));
            continue;
          }
          const sinceGlobal = nowMs - globalLastSend;
          if (sinceGlobal < GLOBAL_MIN_SEND_INTERVAL) {
            await sleep(GLOBAL_MIN_SEND_INTERVAL - sinceGlobal + Math.floor(Math.random() * 200));
            continue;
          }
          const { line: txt, nextIdx } = getNextLine(lines, state);
          state.idx = nextIdx;
          if (!txt || txt.replace(/\s/g, '').length === 0) { await sleep(100); continue; }
          console.log(chalk.red(`[next send] ${now()} -> ${threadId} (idx ${state.idx})`));
          await ent.broadcastText(txt);
          state.lastSentAt = Date.now();
          globalLastSend = state.lastSentAt;
          state.idx++;
          state.firstSent = true;
          state.backoffMultiplier = 1;
          const threadName = (state.threadObj && (state.threadObj.thread_title || (state.threadObj.users && state.threadObj.users[0] && state.threadObj.users[0].username))) || threadId;
          boxedSentLog(threadName, txt);
          await sleep(300 + Math.floor(Math.random() * JITTER_MAX_MS));
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          console.log(chalk.red(`[error send] ${state.threadId}: ${msg}`));
          if (err && (err.statusCode === 429 || (err.name && err.name.toLowerCase().includes('spam')))) {
            const backoff = Math.min(MAX_429_BACKOFF_MS, PER_THREAD_MIN_INTERVAL * (state.backoffMultiplier || 1) * 4);
            globalBackoffUntil = Date.now() + backoff;
            state.backoffMultiplier = (state.backoffMultiplier || 1) * 2;
            console.log(chalk.red(`[rate] 429 detected — backing off ${backoff}ms globally and for thread ${state.threadId}`));
            await sleep(backoff + 200);
          } else {
            state.backoffMultiplier = Math.min(8, (state.backoffMultiplier || 1) * 2);
            const localDelay = Math.min(30_000, PER_THREAD_MIN_INTERVAL * state.backoffMultiplier);
            console.log(chalk.red(`[rate] Error fallback — delaying thread ${state.threadId} for ${localDelay}ms`));
            state.lastSentAt = Date.now() - (PER_THREAD_MIN_INTERVAL - Math.min(PER_THREAD_MIN_INTERVAL, localDelay));
            await sleep(localDelay + Math.floor(Math.random() * 400));
          }
        }
      }
      console.log(chalk.red(`[send-loop] thread loop stopped for ${state.threadId}`));
    }

    for (const s of sendState) {
      perThreadLoop(s).catch(e => console.log(chalk.red('[send-loop] unhandled thread error:'), e && e.message ? e.message : e));
      await sleep(100 + Math.floor(Math.random() * 300));
    }

    process.on('SIGINT', async () => {
      console.log(chalk.red('\nShutdown requested (Ctrl+C). Stopping sends and saving session...'));
      stopped = true;
      await sleep(800);
      try { await saveSession(ig); } catch (e) {}
      if (typeof ig.disconnectRealtime === 'function') try { await ig.disconnectRealtime(); } catch {}
      process.exit(0);
    });

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

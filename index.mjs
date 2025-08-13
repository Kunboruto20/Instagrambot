import { IgApiClient } from 'instagram-private-api';
import inquirer from 'inquirer';
import delay from 'delay';
import fs from 'fs/promises';
import dns from 'dns/promises';

const ig = new IgApiClient();
let messages = [];
const activeLoops = new Map(); // thread_id -> {running, delay}
let ownerUsername = ''; // username-ul proprietarului (cel logat)

// Verifică conexiunea la internet
async function checkInternet() {
  try {
    await dns.lookup('google.com');
    return true;
  } catch {
    return false;
  }
}

async function waitForInternet() {
  console.log('🌐 Aștept conectarea la internet...');
  while (!(await checkInternet())) {
    await delay(3000);
  }
  console.log('✅ Internet conectat.');
}

// Login Instagram
async function login(username, password) {
  ig.state.generateDevice(username);
  try {
    await ig.account.login(username, password);
    ownerUsername = username.toLowerCase(); // salvează proprietarul
    console.log(`✅ Autentificare reușită ca ${ownerUsername}`);
  } catch (err) {
    console.error('❌ Eroare la autentificare:', err.message);
    process.exit(1);
  }
}

// Loop de trimitere mesaje
async function startLoop(threadId, delaySec) {
  if (activeLoops.has(threadId) && activeLoops.get(threadId).running) {
    console.log(`⚠️ Chatul ${threadId} are deja un loop activ.`);
    return;
  }

  activeLoops.set(threadId, { running: true, delay: delaySec });
  console.log(`🚀 Loop pornit pentru chatul ${threadId} cu delay de ${delaySec}s.`);

  while (activeLoops.get(threadId)?.running) {
    for (const message of messages) {
      if (!activeLoops.get(threadId)?.running) break;

      if (!(await checkInternet())) {
        await waitForInternet();
      }

      try {
        await ig.entity.directThread(threadId).broadcastText(message);
        console.log(`✅ Trimisa în ${threadId} -> "${message}"`);
      } catch (err) {
        console.error(`❌ Eroare la trimitere în ${threadId}: ${err.message}`);
      }

      await delay(delaySec * 1000);
    }
  }

  console.log(`⏹ Loop oprit pentru chatul ${threadId}`);
}

// Oprește loop-ul
function stopLoop(threadId) {
  if (activeLoops.has(threadId)) {
    activeLoops.get(threadId).running = false;
  }
}

// Ascultă inbox-ul pentru comenzi
async function listenCommands() {
  console.log('👀 Ascult comenzile din Instagram...');
  let lastChecked = Date.now();

  while (true) {
    try {
      const inbox = ig.feed.directInbox();
      const threads = await inbox.items();

      for (const thread of threads) {
        const lastItem = thread.items[0];
        if (!lastItem) continue;

        const timestamp = parseInt(lastItem.timestamp, 10);
        if (timestamp <= lastChecked) continue;

        const text = lastItem.text?.trim();
        const sender = lastItem.user_id ? thread.users.find(u => u.pk === lastItem.user_id) : null;
        const senderUsername = sender?.username?.toLowerCase();

        // Acceptă comenzi doar de la proprietar
        if (senderUsername !== ownerUsername) {
          continue;
        }

        const threadId = thread.thread_id;

        if (/^\/start\d+$/i.test(text)) {
          const delaySec = parseInt(text.replace('/start', ''), 10);
          if (!isNaN(delaySec) && delaySec >= 0) {
            startLoop(threadId, delaySec);
          }
        } else if (/^\/stop$/i.test(text)) {
          stopLoop(threadId);
        }
      }
      lastChecked = Date.now();
    } catch (err) {
      console.error('❌ Eroare la citirea inbox-ului:', err.message);
    }
    await delay(3000);
  }
}

// Main
async function main() {
  const { username, password } = await inquirer.prompt([
    { type: 'input', name: 'username', message: 'Enter your Instagram username:' },
    { type: 'password', name: 'password', message: 'Enter your Instagram password:' }
  ]);

  await login(username, password);

  const { textFilePath } = await inquirer.prompt([
    {
      type: 'input',
      name: 'textFilePath',
      message: '📄 Introdu calea către fișierul .txt cu mesajele:',
      validate: async (input) => {
        try {
          await fs.access(input);
          return true;
        } catch {
          return 'Fișierul nu există sau nu este accesibil.';
        }
      }
    }
  ]);

  const content = await fs.readFile(textFilePath, 'utf8');
  messages = content.split('\n').filter(line => line.trim().length > 0);

  console.log('✅ Scriptul e gata! Scrie comenzile direct în Instagram (/start5, /stop).');
  await listenCommands();
}

main().catch(err => {
  console.error('❌ Eroare neașteptată:', err);
  process.exit(1);
});

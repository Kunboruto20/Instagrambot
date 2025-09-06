// instagram_spam.js
//
// Script de spam DM în grupuri Instagram folosind instagram-private-api
// Blocat rate-limit 429 prin retry infinit imediat

import { IgApiClient } from 'instagram-private-api';
import readlineSync from 'readline-sync';
import fs from 'fs';

;(async () => {
  // 1. Prompt credențiale
  const username = readlineSync.question('Enter your Instagram username: ');
  const password = readlineSync.question('Enter your Instagram password: ', { hideEchoBack: true });

  // 2. Init și generare device fingerprint
  const ig = new IgApiClient();
  ig.state.generateDevice(username);

  // 3. Monkey-patch pentru IGNORAREA RATE LIMIT (429)
  const originalRequest = ig.client.request.bind(ig.client);
  ig.client.request = async (config) => {
    // retry infinit la 429
    while (true) {
      try {
        return await originalRequest(config);
      } catch (err) {
        if (err.response?.status === 429) {
          // logăm și retry imediat
          console.warn('⚠️ 429 Rate limit detected. Retrying immediately...');
          continue;
        }
        throw err;
      }
    }
  };

  // 4. Login
  try {
    await ig.account.login(username, password);
    console.log('\n✅ Logged in successfully!\n');
  } catch (err) {
    console.error('\n❌ Login failed:', err.response?.data || err.message);
    process.exit(1);
  }

  // 5. Obținere toate thread-urile de grup (mai mulți membri)
  const threadsFeed = ig.feed.directInbox();
  const threads = await threadsFeed.items();
  const groupThreads = threads.filter(t => Array.isArray(t.users) && t.users.length > 1);

  if (groupThreads.length === 0) {
    console.log('No group chats found.');
    process.exit(0);
  }

  // 6. Afișare grupuri
  console.log('Available group chats:');
  groupThreads.forEach((thread, idx) => {
    const names = thread.users.map(u => u.username).join(', ');
    console.log(`${idx + 1}. ${names}`);
  });

  // 7. Selectare grupuri
  const selected = readlineSync.question('\nSelect group numbers (e.g. 1,2,3): ');
  const selectedIndexes = selected
    .split(',')
    .map(i => parseInt(i.trim(), 10) - 1)
    .filter(i => i >= 0 && i < groupThreads.length);
  const selectedThreads = selectedIndexes.map(i => groupThreads[i]);

  if (selectedThreads.length === 0) {
    console.log('❌ No valid group threads selected.');
    process.exit(0);
  }

  // 8. Încărcare fișier text
  const textPath = readlineSync.question('\nEnter your text file path: ');
  if (!fs.existsSync(textPath)) {
    console.error('Text file not found.');
    process.exit(1);
  }
  const raw = fs.readFileSync(textPath, 'utf-8');
  const messages = raw.split(/\r?\n/).filter(Boolean);
  if (messages.length === 0) {
    console.log('No messages found in file.');
    process.exit(0);
  }

  // 9. Prompt delay
  const delaySec = parseInt(readlineSync.question('Enter delay in seconds: '), 10) || 0;

  console.log('\n🚀 Starting spam loop...\n');

  // 10. Loop infinit
  let index = 0;
  while (true) {
    const message = messages[index % messages.length];
    for (const thread of selectedThreads) {
      try {
        await ig.entity.directThread(thread.thread_id).broadcastText(message);
        const names = thread.users.map(u => u.username).join(', ');
        console.log(`✅ Sent to ${names}: ${message}`);
      } catch (err) {
        console.log(`❌ Failed to send to ${thread.thread_id}: ${err.message}`);
      }
    }
    index++;
    // Delay între cicluri
    await new Promise(res => setTimeout(res, delaySec * 1000));
  }
})();

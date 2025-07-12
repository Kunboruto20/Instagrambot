import { IgApiClient } from 'instagram-private-api';
import inquirer from 'inquirer';
import fs from 'fs/promises';
import path from 'path';

const STATE_FILE = path.join(process.cwd(), 'ig.json');

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function saveSession(ig) {
  const state = await ig.state.serialize();
  delete state.constants;
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadSession(ig) {
  const content = await fs.readFile(STATE_FILE, 'utf-8');
  await ig.state.deserialize(JSON.parse(content));
}

async function loginFlow(ig) {
  let username = '';

  if (await fileExists(STATE_FILE)) {
    try {
      const saved = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
      username = saved?.cookies?.cookies?.find(c => c.key === 'ds_user')?.value;
    } catch {
      console.log('⚠️ Fișierul ig.json este corupt. Îl șterg.');
      await fs.unlink(STATE_FILE);
    }
  }

  if (username) {
    const { useSaved } = await inquirer.prompt([
      {
        name: 'useSaved',
        message: `Vrei să folosești contul salvat (${username})?`,
        type: 'confirm',
      },
    ]);

    if (useSaved) {
      ig.state.generateDevice(username);
      try {
        await loadSession(ig);
        await ig.account.currentUser();
        console.log(`✅ Logat automat ca ${username}`);
        return username;
      } catch {
        console.log('❌ Sesiunea salvată a expirat. Facem login nou.');
        await fs.unlink(STATE_FILE);
      }
    }
  }

  const creds = await inquirer.prompt([
    { name: 'username', message: 'Enter your Instagram username:' },
    { name: 'password', message: 'Enter your Instagram password:', type: 'password' },
  ]);

  ig.state.generateDevice(creds.username);
  try {
    await ig.account.login(creds.username, creds.password);
    await saveSession(ig);
    console.log(`✅ Logare reușită ca ${creds.username}`);
    return creds.username;
  } catch (e) {
    console.error('❌ Login eșuat:', e.message || e);
    process.exit(1);
  }
}

async function main() {
  const ig = new IgApiClient();

  // Dezactivează rate limiter
  ig.state.rateLimit = {
    queue: [],
    remaining: Infinity,
    retryAfter: 0,
    maxRequests: Infinity,
    queueRequests: async () => Promise.resolve(),
  };

  const username = await loginFlow(ig);

  const { wantSpam } = await inquirer.prompt([
    {
      name: 'wantSpam',
      message: 'Vrei să trimiți spam? (da/nu)',
      validate: input => ['da', 'nu'].includes(input.toLowerCase()) || 'Răspunde cu da sau nu',
      filter: input => input.toLowerCase(),
    },
  ]);

  if (wantSpam !== 'da') {
    console.log('👋 La revedere!');
    process.exit(0);
  }

  const { textFilePath } = await inquirer.prompt([
    {
      name: 'textFilePath',
      message: 'Enter your text path here:',
      validate: async (input) => {
        try {
          await fs.access(input);
          return true;
        } catch {
          return 'Fișierul nu există.';
        }
      },
    },
  ]);

  const { targetType } = await inquirer.prompt([
    {
      name: 'targetType',
      message: 'Unde vrei să trimiți spam? Scrie "utilizatori" sau "grupuri":',
      validate: input => ['utilizatori', 'grupuri'].includes(input.toLowerCase()) || 'Scrie exact "utilizatori" sau "grupuri"',
      filter: input => input.toLowerCase(),
    },
  ]);

  let targets = [];

  if (targetType === 'utilizatori') {
    const { usersRaw } = await inquirer.prompt([
      {
        name: 'usersRaw',
        message: 'Introdu numele utilizatorilor cu virgule (ex: Mihai,Daniel):',
        validate: input => input.trim() !== '',
      },
    ]);
    targets = usersRaw.split(',').map(u => u.trim()).filter(Boolean);
  } else {
    console.log('\nGyovanny îți arată toate grupurile acum ✍️❣️\n');
    const threadsFeed = ig.feed.directInbox();
    const threads = await threadsFeed.items();
    const groupThreads = threads.filter(t => t.users.length > 2);

    if (groupThreads.length === 0) {
      console.log('❌ Nu ai grupuri disponibile.');
      process.exit(1);
    }

    groupThreads.forEach((group, idx) => {
      console.log(`${idx + 1}. ${group.thread_title || '(Fără nume)'} (${group.users.length} membri)`);
    });

    const { selectedIndexes } = await inquirer.prompt([
      {
        name: 'selectedIndexes',
        message: 'Scrie numerele grupurilor separate prin virgulă (ex: 1,3):',
        validate: input => {
          const valid = input.split(',').every(n => {
            const i = parseInt(n.trim(), 10);
            return !isNaN(i) && i > 0 && i <= groupThreads.length;
          });
          return valid || 'Numere invalide.';
        }
      }
    ]);

    const indexes = selectedIndexes.split(',').map(n => parseInt(n.trim(), 10) - 1);
    targets = indexes.map(i => groupThreads[i].thread_id);
  }

  const { delaySec } = await inquirer.prompt([
    {
      name: 'delaySec',
      message: 'Enter delay seconds here:',
      validate: input => !isNaN(Number(input)) && Number(input) >= 0,
      filter: Number,
    },
  ]);

  const fileContent = await fs.readFile(textFilePath, 'utf-8');
  const messages = fileContent.split(/\r?\n/).filter(Boolean);

  if (messages.length === 0) {
    console.log('❌ Fișierul este gol.');
    process.exit(1);
  }

  async function reconnect() {
    while (true) {
      try {
        console.log('🔁 Reconectare...');
        await loginFlow(ig);
        console.log('✅ Reconectat!');
        return;
      } catch (e) {
        console.error('❌ Eroare la reconectare:', e.message || e);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }

  async function sendMessageToTarget(target, message) {
    try {
      if (targetType === 'utilizatori') {
        const userId = await ig.user.getIdByUsername(target);
        const thread = ig.entity.directThread([userId.toString()]);
        await thread.broadcastText(message);
      } else {
        // Pentru grupuri: folosim direct threadId, nu array
        const thread = ig.entity.directThread(target);
        await thread.broadcastText(message);
      }
      console.log(`✅ Mesaj trimis către ${target}: ${message}`);
    } catch (e) {
      console.error(`❌ Eroare trimitere către ${target}:`, e.message || e);
      if (
        e.message?.includes('timeout') ||
        e.statusCode === 429 ||
        e.message?.includes('ENOTFOUND') ||
        e.message?.includes('EAI_AGAIN')
      ) {
        console.log('🌐 Problemă de rețea. Reîncerc...');
        await reconnect();
      }
    }
  }

  while (true) {
    for (const msg of messages) {
      for (const target of targets) {
        await sendMessageToTarget(target, msg);
        await new Promise(r => setTimeout(r, delaySec * 1000));
      }
    }
  }
}

main();

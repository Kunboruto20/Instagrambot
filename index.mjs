import { IgApiClient } from 'instagram-private-api';
import inquirer from 'inquirer';
import delay from 'delay';
import fs from 'fs/promises';
import dns from 'dns/promises';

const ig = new IgApiClient();

async function login() {
  const { username, password } = await inquirer.prompt([
    { type: 'input', name: 'username', message: 'Enter Instagram username:' },
    { type: 'password', name: 'password', message: 'Enter Instagram password:' }
  ]);

  ig.state.generateDevice(username);
  try {
    await ig.account.login(username, password);
    console.log('✅ Autentificare reușită!');
  } catch (err) {
    console.error('❌ Eroare la autentificare:', err.message);
    process.exit(1);
  }
}

async function getGroupThreads() {
  const threadsFeed = ig.feed.directInbox();
  const threads = await threadsFeed.items();

  // Grup = minim 2 participanți
  const groups = threads.filter(thread => thread.users?.length >= 2);

  if (groups.length === 0) {
    console.log('⚠️ Niciun grup găsit.');
    process.exit(1);
  }

  console.log('\n📂 Grupuri disponibile:');
  groups.forEach((group, index) => {
    const title = group.thread_title || `Grup ${index + 1}`;
    const names = group.users.map(u => u.username).join(', ');
    console.log(`${index + 1}. ${title} (${names})`);
  });

  return groups;
}

// Verifică dacă internetul e conectat încercând să rezolve google.com
async function checkInternet() {
  try {
    await dns.lookup('google.com');
    return true;
  } catch {
    return false;
  }
}

// Așteaptă până când apare conexiunea la internet
async function waitForInternet() {
  console.log('🌐 Aștept conectarea la internet...');
  while (!(await checkInternet())) {
    await delay(3000); // verifică la 3 secunde
  }
  console.log('✅ Internetul este conectat.');
}

async function main() {
  await login();

  const groups = await getGroupThreads();

  const { selectedIndexes } = await inquirer.prompt([
    {
      type: 'input',
      name: 'selectedIndexes',
      message: '🔢 Selectează grupurile (ex: 1,2,3):'
    }
  ]);

  const groupIndexes = selectedIndexes.split(',').map(i => parseInt(i.trim()) - 1);
  const selectedGroups = groupIndexes.map(index => groups[index]).filter(Boolean);

  if (selectedGroups.length === 0) {
    console.log('❌ Niciun grup valid selectat.');
    return;
  }

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

  const { delaySeconds } = await inquirer.prompt([
    {
      type: 'number',
      name: 'delaySeconds',
      message: '⏳ Introdu delay în secunde între mesaje (poate fi 0):',
      default: 5,
      validate: (input) => input >= 0 || 'Trebuie să fie un număr >= 0'
    }
  ]);

  const content = await fs.readFile(textFilePath, 'utf8');
  const messages = content.split('\n').filter(line => line.trim().length > 0);

  console.log(`\n🚀 Încep trimiterea mesajelor către ${selectedGroups.length} grupuri cu delay de ${delaySeconds} secunde...\n`);

  while (true) {
    for (const message of messages) {
      // Dacă nu există conexiune internet, așteaptă reconectarea
      while (!(await checkInternet())) {
        await waitForInternet();
      }

      for (const group of selectedGroups) {
        try {
          await ig.entity.directThread(group.thread_id).broadcastText(message);
          const usernames = group.users.map(u => u.username).join(', ');
          console.log(`✅ Mesaj trimis către: ${group.thread_title || 'Grup fără nume'} (${usernames}) -> "${message}"`);
        } catch (err) {
          const usernames = group.users.map(u => u.username).join(', ');
          console.log(`❌ Eroare la ${group.thread_title || 'Grup fără nume'} (${usernames}): ${err.message}`);
        }
      }

      if (delaySeconds > 0) {
        await delay(delaySeconds * 1000);
      }
    }
  }
}

main().catch(err => {
  console.error('❌ Eroare neașteptată:', err);
  process.exit(1);
});

#!/usr/bin/env node

const { IgApiClient } = require("instagram-private-api");
const readline = require("readline");
const fs = require("fs");
const http = require("http");

const CREDENTIALS_FILE = "./ig_creds.json";

// Banner de pornire
console.log("********************************************");
console.log("*      Gyovanny srg bot instagram          *");
console.log("********************************************");

// Funcție helper pentru a obține input-ul din terminal
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Helper de delay (în milisecunde)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Verifică conexiunea la internet
async function isOnline() {
  return new Promise((resolve) => {
    const req = http.get("http://clients3.google.com/generate_204", () => {
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Așteaptă revenirea conexiunii la internet
async function waitForNetwork() {
  console.log("Internetul s-a pierdut, aștept conexiunea la internet...");
  while (!(await isOnline())) {
    console.log("Network still down, retrying in 10 seconds...");
    await delay(10000);
  }
  console.log("Internetul a revenit, reluăm trimiterea de unde am rămas🔥");
}

// Funcție pentru executarea sigură a operațiilor de trimitere
async function safeSend(sendFunction, ...params) {
  while (true) {
    try {
      await sendFunction(...params);
      return;
    } catch (err) {
      if (!(await isOnline())) {
        console.error("Internetul s-a pierdut, aștept conexiunea la internet...");
        await waitForNetwork();
      } else {
        console.error("Error encountered:", err.message, ". Reîncercăm după 5 secunde...");
        await delay(5000);
      }
    }
  }
}

// Funcție pentru reautentificare manuală (când datele salvate nu mai funcționează)
async function reLogin(ig) {
  while (true) {
    console.log("Session invalid. Re-authentication required.");
    const username = await askQuestion("Enter your Instagram email or phone number: ");
    const password = await askQuestion("Enter your Instagram password: ");
    ig.state.generateDevice(username);
    try {
      await ig.account.login(username, password);
      console.log("Login successful!");
      const cookies = await ig.state.serializeCookieJar();
      const creds = { username, password, cookies };
      fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
      break;
    } catch (e) {
      console.error("Login failed! Retrying in 10 seconds...", e.message);
      await delay(10000);
    }
  }
}

// Inițializează sesiunea Instagram.
// Dacă există fișierul cu date salvate, se întrebă:
// "Contul salvat este [username]. Vrei să folosești acest cont? (da/nu):"
// Dacă răspunzi "da", se încearcă autologin cu datele salvate; dacă nu, se solicită introducerea de noi date.
async function initInstagram() {
  const ig = new IgApiClient();
  ig.challenge.auto = true; // rezolvă automat challenge‑urile
  let credentials = null;
  
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
    } catch (e) {
      console.error("Error reading credentials file:", e.message);
    }
  }
  
  if (credentials && credentials.username && credentials.password && credentials.cookies) {
    let answer = await askQuestion(`Contul salvat este ${credentials.username}. Vrei să folosești acest cont? (da/nu): `);
    if (answer.toLowerCase() === "da") {
      ig.state.generateDevice(credentials.username);
      try {
        await ig.state.deserializeCookieJar(JSON.stringify(credentials.cookies));
        // Se testează sesiunea pentru a verifica dacă datele salvate sunt valide
        const user = await ig.account.currentUser();
        console.log(`Logged in as: ${user.username}`);
      } catch (e) {
        console.error("Session invalid. Încercăm re-login folosind datele salvate...");
        try {
          await ig.account.login(credentials.username, credentials.password);
          console.log("Logged in successfully with saved credentials.");
          const cookies = await ig.state.serializeCookieJar();
          const creds = { username: credentials.username, password: credentials.password, cookies };
          fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
        } catch (ex) {
          console.error("Re-login failed with saved credentials. Te rugăm să introduci date noi.");
          await reLogin(ig);
        }
      }
    } else {
      await reLogin(ig);
    }
  } else {
    await reLogin(ig);
  }
  return ig;
}

// Listează conversațiile (grupurile) din inbox și afișează un mesaj personalizat
async function listThreads(ig) {
  try {
    const inboxFeed = ig.feed.directInbox();
    const threads = await inboxFeed.items();
    if (!threads || threads.length === 0) {
      console.log("Inbox-ul este gol.");
      return [];
    }
    
    console.log("\n🔥 Ești bun, acestea sunt grupurile după contul tău, selectează grupurile 😂🔥\n");
    
    const validThreads = [];
    threads.forEach((thread, index) => {
      if (!thread || !thread.thread_id) return;
      const title = thread.thread_title || (thread.users && thread.users.map((u) => u.username).join(", ")) || "N/A";
      console.log(`${index + 1}. ${title} (ID: ${thread.thread_id})`);
      validThreads.push(thread.thread_id);
    });
    return validThreads;
  } catch (e) {
    console.error("Error listing threads:", e.message);
    return [];
  }
}

// Funcții pentru trimiterea mesajelor text și a pozelor
async function sendTextToGroup(ig, threadId, text) {
  await ig.entity.directThread(threadId).broadcastText(text);
  console.log("Mesajul a fost trimis cu succes (grup): " + threadId);
}

async function sendTextToUsers(ig, userIds, text) {
  await ig.entity.directThread(userIds).broadcastText(text);
  console.log("Mesajul a fost trimis cu succes (utilizatori).");
}

async function sendPhotoToGroup(ig, threadId, photoBuffer, caption) {
  await ig.entity.directThread(threadId).broadcastPhoto({ file: photoBuffer, caption: caption });
  console.log("Poză trimisă cu succes la grup: " + threadId);
}

async function sendPhotoToUsers(ig, userIds, photoBuffer, caption) {
  await ig.entity.directThread(userIds).broadcastPhoto({ file: photoBuffer, caption: caption });
  console.log("Poză trimisă cu succes la utilizatori.");
}

// Meniul interactiv
// Am modificat ramura pentru "mesaje text" astfel încât să citească întregul fișier și să trimită textul într-un loop infinit.
async function menu(ig) {
  while (true) {
    console.log("\nCe vrei să trimiți?");
    console.log("1. Mesaje text");
    console.log("2. Poze");
    const contentChoice = await askQuestion("Alege opțiunea (1/2): ");
    let isText;
    if (contentChoice === "1") isText = true;
    else if (contentChoice === "2") isText = false;
    else {
      console.log("Opțiune invalidă.");
      continue;
    }
    
    console.log("\nUnde vrei să trimiți?");
    console.log("1. Utilizatori");
    console.log("2. Grupuri");
    const destinationChoice = await askQuestion("Alege opțiunea (1/2): ");
    
    let recipientUserIds = [];
    let selectedThreads = [];
    
    if (destinationChoice === "1") {
      const usersInput = await askQuestion("Introduceți username-urile destinație (separate prin virgulă): ");
      const usernames = usersInput.split(",").map(u => u.trim()).filter(u => u);
      for (const uname of usernames) {
        try {
          const user = await ig.user.searchExact(uname);
          recipientUserIds.push(user.pk.toString());
        } catch (e) {
          console.error(`Nu s-a putut găsi ${uname}:`, e.message);
        }
      }
      if (recipientUserIds.length === 0) {
        console.error("Niciun utilizator valid găsit.");
        continue;
      }
    } else if (destinationChoice === "2") {
      const threads = await listThreads(ig);
      if (threads.length === 0) {
        console.error("Niciun grup disponibil.");
        continue;
      }
      const threadNums = await askQuestion("Introduceți numerele thread-urilor dorite (separate prin virgulă): ");
      const indices = threadNums.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      selectedThreads = indices.map(i => threads[i - 1]).filter(id => id !== undefined);
      if (selectedThreads.length === 0) {
        console.error("Niciun thread valid selectat.");
        continue;
      }
    } else {
      console.error("Opțiune de destinație nevalidă.");
      continue;
    }
    
    const delayInput = await askQuestion("Enter Delay seconds (default 50): ");
    let delayMs = 50000;
    if (delayInput && !isNaN(parseFloat(delayInput))) {
      delayMs = parseFloat(delayInput) * 1000;
    }
    
    if (isText) {
      // Citim întregul fișier de text și îl trimitem într-un loop infinit
      const textPath = await askQuestion("Enter your text path here: ");
      let textContent = "";
      try {
        textContent = fs.readFileSync(textPath, "utf8");
      } catch (e) {
        console.error("Error reading text file:", e.message);
        continue;
      }
      console.log("\nTrimiterea mesajelor începe... (Întregul conținut va fi trimis la fiecare iterație)");
      while (true) {
        if (destinationChoice === "1") {
          await safeSend(sendTextToUsers, ig, recipientUserIds, textContent);
        } else {
          for (const threadId of selectedThreads) {
            await safeSend(sendTextToGroup, ig, threadId, textContent);
          }
        }
        await delay(delayMs);
      }
    } else {
      // Modul poze: se trimite poza într-un loop infinit
      const photoPath = await askQuestion("Enter your photo path here: ");
      let photoBuffer;
      try {
        photoBuffer = fs.readFileSync(photoPath);
      } catch (e) {
        console.error("Error reading photo file:", e.message);
        continue;
      }
      const caption = await askQuestion("Enter the text to appear with your photo: ");
      console.log("\nTrimiterea pozelor a început (Ctrl+C pentru oprire). Scriptul va trimite poze non-stop...");
      while (true) {
        if (destinationChoice === "1") {
          await safeSend(sendPhotoToUsers, ig, recipientUserIds, photoBuffer, caption);
        } else {
          for (const threadId of selectedThreads) {
            await safeSend(sendPhotoToGroup, ig, threadId, photoBuffer, caption);
          }
        }
        await delay(delayMs);
      }
    }
  }
}

(async () => {
  try {
    const ig = await initInstagram();
    await menu(ig);
  } catch (err) {
    console.error("Unexpected error:", err);
  }
})();

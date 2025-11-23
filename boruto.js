const readline = require('readline');
const {
  IgApiClient,
  RealtimeClient,
  IrisHandshake,
  SkywalkerProtocol,
  PresenceManager,
  DMSender
} = require('nodejs-insta-private-api');

// Funcție pentru citirea inputului din consolă
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function InstagramMQTT() {
  const ig = new IgApiClient();

  // 1. LOGIN INTERACTIV
  const username = await askQuestion('Enter your Instagram username: ');
  const password = await askQuestion('Enter your Instagram password: ');
  const email = await askQuestion('Enter your Instagram email: ');

  await ig.login({
    username,
    password,
    email
  });

  console.log('✅ Login successful!\n');

  // 2. CREATE REALTIME CLIENT
  const realtime = new RealtimeClient(ig);

  // 3. LISTEN TO MESSAGES
  realtime.on('message', (data) => {
    const msg = data.message;
    console.log(`📨 ${msg.user_id}: ${msg.text}`);
  });

  // 4. LISTEN TO TYPING
  realtime.on('typing', (data) => {
    if (data.is_typing) {
      console.log(`✏️  ${data.user_id} is typing...`);
    }
  });

  // 5. LISTEN TO REACTIONS
  realtime.on('reaction', (data) => {
    console.log(`${data.user_id} reacted ${data.emoji} to message ${data.message_id}`);
  });

  // 6. LISTEN TO PRESENCE
  realtime.on('presence', (data) => {
    console.log(`🟢 ${data.user_id} is ${data.status}`);
  });

  // 7. LISTEN TO GAPS
  realtime.on('gap', (data) => {
    console.log(`⚠️ Gap detected - auto-syncing messages ${data.gap_from} to ${data.gap_to}`);
  });

  // 8. CONNECT TO MQTT
  await realtime.connect({
    graphQlSubs: ['ig_sub_direct'],
    irisData: null
  });

  console.log('✅ Connected like Instagram app!\n');

  // 9. SEND MESSAGES FAST
  const targetUser = await askQuestion('Enter the target Instagram username: ');
  const user = await ig.user.getByUsername(targetUser);
  const threadId = user.id;

  // Show typing
  await realtime.sendTyping(threadId, true);

  // Send message
  await realtime.dmSender.sendTextMessage(threadId, 'Hey! Sent via MQTT like Instagram! ⚡');

  // Stop typing
  await realtime.sendTyping(threadId, false);

  // 10. SEND REACTIONS
  await realtime.sendReaction('message_id_123', threadId, '❤️');

  // 11. BROADCAST PRESENCE
  await realtime.presenceManager.broadcastPresence('online');

  console.log('⏳ Waiting for messages... (Press Ctrl+C to stop)\n');
}

InstagramMQTT().catch(console.error);

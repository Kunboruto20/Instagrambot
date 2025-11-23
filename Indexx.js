#!/usr/bin/env node

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { IgApiClient, RealtimeClient } = require('nodejs-insta-private-api');

const SESSION_FILE = path.join(__dirname, '.dm-session.json');

// Color output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  red: '\x1b[31m'
};

function log(color, ...args) {
  console.log(color + args.join(' ') + colors.reset);
}

function question(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      log(colors.cyan, '📂 Found saved session, using it...\n');
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      return data;
    }
  } catch (err) {
    log(colors.yellow, '⚠️  Could not load session:', err.message);
  }
  return null;
}

async function saveSession(sessionData) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
    log(colors.green, '💾 Session saved for next time\n');
  } catch (err) {
    log(colors.yellow, '⚠️  Could not save session:', err.message);
  }
}

async function login(ig, username, password) {
  log(colors.cyan, '🔐 Authenticating...');
  
  try {
    await ig.login({
      username: username,
      password: password
    });
    
    log(colors.green, '✅ Logged in successfully!\n');
    
    // Save session
    await saveSession({
      username: username,
      loginTime: new Date().toISOString()
    });
    
    return true;
  } catch (err) {
    log(colors.red, '❌ Login failed:', err.message);
    
    if (err.message.includes('challenge')) {
      log(colors.yellow, '💡 Instagram is asking for verification. Please verify in the app and try again.\n');
    }
    if (err.message.includes('bad_password')) {
      log(colors.yellow, '💡 Invalid username or password. Try again.\n');
    }
    
    return false;
  }
}

async function startListener(ig) {
  log(colors.cyan, '\n🚀 Connecting to Instagram MQTT...');
  
  const realtime = new RealtimeClient(ig);
  let messageCount = 0;
  let isConnected = false;

  // Connection established
  realtime.on('connected', () => {
    isConnected = true;
    log(colors.green, '✅ Connected to Instagram real-time messaging\n');
    log(colors.bright, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(colors.bright, '💬 Listening for DMs... (Send a message to see it here)\n');
  });

  // Disconnect
  realtime.on('disconnected', () => {
    isConnected = false;
    log(colors.yellow, '⚠️  Disconnected from MQTT');
  });

  // Connection error
  realtime.on('error', (err) => {
    log(colors.red, '❌ MQTT Error:', err.message);
  });

  // Receive messages
  realtime.on('receive', (topic, messages) => {
    if (!messages || messages.length === 0) return;

    messages.forEach((msg) => {
      messageCount++;

      // Extract message data
      let fromUser = 'Unknown';
      let messageText = '';
      let threadTitle = 'Unknown';
      let messageType = 'text';

      // Check for text messages
      if (msg.message?.items) {
        msg.message.items.forEach((item) => {
          if (item.text) {
            messageText = item.text;
            messageType = 'text';
          } else if (item.media) {
            messageType = 'photo';
            messageText = '[Photo]';
          } else if (item.video_media) {
            messageType = 'video';
            messageText = '[Video]';
          } else if (item.voice_media) {
            messageType = 'voice';
            messageText = '[Voice Message]';
          } else if (item.share) {
            messageType = 'share';
            messageText = '[Shared Content]';
          } else if (item.reel_share) {
            messageType = 'reel';
            messageText = '[Shared Reel]';
          } else if (item.link) {
            messageType = 'link';
            messageText = '[Link: ' + (item.link.url || 'unknown') + ']';
          } else {
            messageType = 'other';
            messageText = '[Message]';
          }

          if (item.user_id) {
            fromUser = item.user_id;
          }
        });
      }

      // Check for thread info
      if (msg.thread) {
        threadTitle = msg.thread.title || threadTitle;
      }

      // Display the message
      if (messageText) {
        log(colors.bright, `\n─ Message #${messageCount}`);
        log(colors.cyan, `   From: ${fromUser}`);
        log(colors.magenta, `   Chat: ${threadTitle}`);
        log(colors.yellow, `   Type: ${messageType}`);
        log(colors.bright, `   Text: ${messageText}`);
        
        if (msg.timestamp) {
          const time = new Date(msg.timestamp * 1000).toLocaleTimeString();
          log(colors.cyan, `   Time: ${time}`);
        }
      }
    });
  });

  // Start connection
  try {
    await realtime.connect({
      graphQlSubs: ['ig_sub_direct'],
      irisData: null
    });

    log(colors.green, '✅ MQTT subscriptions active\n');

  } catch (err) {
    log(colors.red, '❌ Failed to connect:', err.message);
    process.exit(1);
  }

  // Keep process alive
  return new Promise(() => {
    // Never resolve - keep listening forever
  });
}

async function main() {
  console.clear();
  log(colors.bright + colors.green, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(colors.bright + colors.green, '📱 Instagram Real-Time DM Listener');
  log(colors.bright + colors.green, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const ig = new IgApiClient();

  // Try to use saved session first
  const savedSession = await loadSession();
  
  if (!savedSession) {
    // Need to login manually
    const username = await question(colors.cyan + 'Enter Instagram username: ' + colors.reset);
    const password = await question(colors.cyan + 'Enter Instagram password: ' + colors.reset);

    const success = await login(ig, username, password);
    if (!success) {
      process.exit(1);
    }
  } else {
    log(colors.green, '✅ Using saved session\n');
  }

  // Start listening
  try {
    await startListener(ig);
  } catch (err) {
    log(colors.red, '❌ Error:', err.message);
    process.exit(1);
  }
}

// Run
main().catch((err) => {
  log(colors.red, '❌ Fatal error:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log(colors.yellow, '\n\n👋 Stopping listener...');
  process.exit(0);
});

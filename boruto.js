#!/usr/bin/env node
/**
 * Instagram Live Messages Viewer
 * 
 * A complete example showing how to:
 * 1. Login to Instagram
 * 2. Connect to MQTT real-time broker
 * 3. Listen for live messages, typing indicators, and reactions
 * 
 * Usage: node instagram-live-messages.js
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Import everything from the library
const {
  IgApiClient,
  RealtimeClient,
  IrisHandshake,
  SkywalkerProtocol,
  PresenceManager,
  DMSender,
  ErrorHandler,
  GapHandler,
  EnhancedDirectCommands,
  Topics
} = require('nodejs-insta-private-api');

// Session file path
const SESSION_FILE = path.join(process.cwd(), '.instagram-session.json');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to prompt user
function prompt(question) {
  return new Promise(resolve => {
    rl.question(question, resolve);
  });
}

// Main function
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('📱 Instagram Live Messages Viewer');
  console.log('='.repeat(60) + '\n');

  try {
    let username, password;
    let ig;

    // Check if session file exists
    if (fs.existsSync(SESSION_FILE)) {
      console.log('✅ Found existing session file\n');
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      
      ig = new IgApiClient();
      await ig.loadSession(sessionData);
      
      console.log('✅ Session loaded successfully\n');
    } else {
      // Prompt for credentials
      console.log('🔑 Please enter your Instagram credentials:\n');
      username = await prompt('📧 Instagram username: ');
      
      // Hide password input
      console.log('🔐 Password (input hidden):');
      const password_input = await new Promise(resolve => {
        rl.question('', resolve);
      });
      password = password_input;

      console.log('\n⏳ Authenticating...\n');

      // Create client and login
      ig = new IgApiClient();
      ig.state.generateDevice(username);

      try {
        await ig.account.login(username, password);
        console.log('✅ Login successful!\n');

        // Save session for future use
        const session = await ig.saveSession();
        fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
        console.log('💾 Session saved to', SESSION_FILE, '\n');
      } catch (loginError) {
        console.error('❌ Login failed:', loginError.message);
        console.error('   Make sure your username and password are correct\n');
        process.exit(1);
      }
    }

    // Get user info
    const userInfo = await ig.user.currentUser();
    console.log(`👤 Logged in as: ${userInfo.username} (ID: ${userInfo.id})\n`);

    // Initialize realtime client
    console.log('🔌 Connecting to Instagram MQTT broker...\n');
    const realtime = new RealtimeClient(ig);

    let messageCount = 0;
    let typingCount = 0;
    let reactionCount = 0;

    // Listen for messages
    realtime.on('message', (data) => {
      messageCount++;
      const msg = data.message;
      const timestamp = new Date().toLocaleTimeString();
      
      console.log(`\n📨 [${timestamp}] NEW MESSAGE [#${messageCount}]`);
      console.log('   ├─ From: ' + (msg.user_id || 'unknown'));
      console.log('   ├─ Text: ' + (msg.text || '[no text]'));
      console.log('   ├─ Thread: ' + (msg.thread_id || 'unknown'));
      console.log('   └─ Timestamp: ' + (msg.timestamp || 'N/A'));
    });

    // Listen for typing indicators
    realtime.on('typing', (data) => {
      const timestamp = new Date().toLocaleTimeString();
      
      if (data.is_typing) {
        typingCount++;
        console.log(`\n⌨️  [${timestamp}] USER TYPING`);
        console.log('   ├─ User ID: ' + data.user_id);
        console.log('   └─ Thread: ' + data.thread_id);
      }
    });

    // Listen for reactions
    realtime.on('reaction', (data) => {
      reactionCount++;
      const timestamp = new Date().toLocaleTimeString();
      
      console.log(`\n😍 [${timestamp}] REACTION [#${reactionCount}]`);
      console.log('   ├─ Emoji: ' + (data.emoji || '?'));
      console.log('   ├─ From: ' + data.user_id);
      console.log('   ├─ Message: ' + data.message_id);
      console.log('   └─ Thread: ' + data.thread_id);
    });

    // Listen for presence (online/offline)
    realtime.on('presence', (data) => {
      const timestamp = new Date().toLocaleTimeString();
      const status = data.status || 'unknown';
      
      console.log(`\n🟢 [${timestamp}] PRESENCE UPDATE`);
      console.log('   ├─ User: ' + data.user_id);
      console.log('   └─ Status: ' + status);
    });

    // Listen for errors
    realtime.on('error', (error) => {
      console.error('\n❌ MQTT Error:', error.message);
    });

    // Listen for connection events
    realtime.on('connected', () => {
      console.log('✅ Connected to MQTT broker!\n');
      console.log('🎧 Listening for messages...');
      console.log('   (Press Ctrl+C to exit)\n');
    });

    realtime.on('disconnect', () => {
      console.log('\n⚠️  Disconnected from MQTT broker');
    });

    // Connect with direct message subscription
    try {
      await realtime.connect({
        graphQlSubs: ['ig_sub_direct'],
        irisData: null,
        autoReconnect: true
      });
    } catch (connectError) {
      console.error('❌ Connection failed:', connectError.message);
      process.exit(1);
    }

    // Keep script running
    process.on('SIGINT', async () => {
      console.log('\n\n📊 Session Statistics:');
      console.log('   Messages received: ' + messageCount);
      console.log('   Typing events: ' + typingCount);
      console.log('   Reactions: ' + reactionCount);
      console.log('\n✅ Goodbye!\n');
      
      rl.close();
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
    rl.close();
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  console.error('❌ Unexpected error:', error);
  rl.close();
  process.exit(1);
});

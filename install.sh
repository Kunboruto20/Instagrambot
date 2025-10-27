#!/bin/bash

# -----------------------------
# Install Script for Instagram Bot
# -----------------------------

echo "🚀 Starting installation..."

# Update and upgrade Termux/Linux packages
echo "🔄 Updating system packages..."
pkg update -y && pkg upgrade -y

# Install Node.js, npm, git if not installed
echo "📦 Installing Node.js, npm, git..."
pkg install -y nodejs git

# Check Node.js and npm versions
echo "✅ Node.js version: $(node -v)"
echo "✅ npm version: $(npm -v)"

# Navigate to script directory (assume current)
DIR=$(pwd)
echo "📁 Working directory: $DIR"

# Install npm dependencies at latest
echo "📥 Installing npm dependencies..."
npm install nodejs-insta-private-api@latest readline-sync@latest chalk@4 fs-extra@latest

# Optional: update all other deps from package.json to latest
npm install

# Ensure package.json has a start script
if ! grep -q '"start":' package.json; then
  echo "⚠️ No start script found in package.json. Adding default 'node 222.js'..."
  npx json -I -f package.json -e 'this.scripts=this.scripts||{};this.scripts.start="node 222.js"'
fi

# Start the bot
echo "🤖 Starting the bot..."
npm start

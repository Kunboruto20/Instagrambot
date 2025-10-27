#!/bin/bash

# install.sh - Install all dependencies at latest and start the Instagram bot

echo "==> Updating system packages..."
pkg update -y && pkg upgrade -y

echo "==> Installing Node.js and git..."
pkg install -y nodejs git

# Navigate to script directory
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "==> Setting up package.json if missing..."
if [ ! -f package.json ]; then
  npm init -y
fi

# Detect main file from package.json or default to index.js
MAIN_FILE=$(node -p "require('./package.json').main || 'index.js'")
echo "==> Main file detected: $MAIN_FILE"

echo "==> Installing dependencies at latest versions..."
npm install nodejs-insta-private-api@latest readline-sync@latest chalk@4@latest vaga@latest fs-extra@latest

echo "==> Adding start script to package.json..."
npm set-script start "node $MAIN_FILE"

echo "==> Starting Instagram bot..."
npm start

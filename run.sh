#!/usr/bin/env bash
# TASKZ - KPLC Prepaid Token Tracker
# Usage: ./run.sh
# Set TASKZ_TELEGRAM_BOT_TOKEN in .env to enable Telegram alerts

set -e
# Move to the PROJECT ROOT (the folder containing run.sh and the app/ folder)
cd "$(dirname "$0")"

if [ ! -f "app/main.py" ]; then
    echo "ERROR: Cannot find app/main.py. Make sure you run this from the project root."
    echo "  The folder containing run.sh should also contain the 'app/' folder."
    exit 1
fi

# Create venv if not exists
if [ ! -d "venv" ]; then
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
else
    source venv/bin/activate
fi

# Ensure data directory exists
mkdir -p data

# Ensure .env exists
if [ ! -f ".env" ]; then
    cp .env.example .env 2>/dev/null || true
    echo ".env created from defaults. Edit it to set your SECRET_KEY and TELEGRAM_BOT_TOKEN."
fi

# Run from the project root so Python finds "app/" as a package
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

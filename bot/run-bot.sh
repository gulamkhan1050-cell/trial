#!/usr/bin/env sh
# Keeps the headless bot running on a phone: holds a wake lock (Termux) and restarts it after a
# crash or network drop. Stops for good on Ctrl+C (exit 0), bad settings (2) or the kill switch (3).
cd "$(dirname "$0")/.." || exit 1
command -v termux-wake-lock >/dev/null && termux-wake-lock
npx vite build --ssr bot/bot.ts --outDir dist-bot --emptyOutDir --logLevel warn || exit 1
while true; do
  node dist-bot/bot.js "$@"
  code=$?
  case $code in 0|2|3|5) break ;; esac
  echo "bot exited ($code) — restarting in 15 s (Ctrl+C to stop)"
  sleep 15
done
command -v termux-wake-unlock >/dev/null && termux-wake-unlock
exit $code

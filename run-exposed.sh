#!/bin/bash
# Run Lemma and expose it to the local network (accessible by other PCs)
# To connect, find this Mac's IP (e.g., run `ipconfig getifaddr en0`) and go to http://<IP>:5173

echo "Your local IP addresses:"
ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}'

echo "Starting Lemma exposed..."
npx concurrently -k ".venv/bin/python app.py" "npx vite --host"

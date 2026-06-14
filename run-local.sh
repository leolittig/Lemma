#!/bin/bash
# Run Lemma locally (accessible only on this machine)
npx concurrently -k ".venv/bin/python app.py" "npx vite"

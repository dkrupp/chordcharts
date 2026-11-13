#!/usr/bin/env bash
# Builds one-page, two-column PDFs from all .cm files into ./pdf
set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${CHROME_PATH:-}" ]]; then
	if [[ "$(uname)" == "Darwin" ]]; then
		CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	else
		CHROME_PATH="$(command -v google-chrome || command -v chromium || true)"
	fi
fi
export CHROME_PATH

(cd .github/scripts && npm install --no-audit --no-fund --silent)
node .github/scripts/build-pdfs.mjs . pdf

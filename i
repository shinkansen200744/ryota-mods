#!/bin/sh
# usage-meter を入れる（Mac・Linux・Git Bash）：curl -fsSL https://<owner>.github.io/ryota-mods/i | sh
set -e
REPO="${REPO:-__OWNER__/ryota-mods}"
claude plugin marketplace add "$REPO" 2>/dev/null || claude plugin marketplace update ryota-mods
claude plugin install usage-meter@ryota-mods
echo "入りました。Claude Code を開き直すと、使用量のパネルが出ます（/um でも開けます）"

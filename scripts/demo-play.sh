#!/usr/bin/env bash
# Simulates a claude-pool demo session for VHS recording.
# Produces realistic-looking terminal output without requiring
# a running server or real API keys.

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

fake_type() {
  local text="$1"
  local delay="${2:-0.04}"
  printf "%s" "$ "
  for (( i=0; i<${#text}; i++ )); do
    printf '%s' "${text:$i:1}"
    sleep "$delay"
  done
  echo ""
}

# ── Scene 1: show pool ────────────────────────────────────────────────────────
fake_type "claude-pool pool"
sleep 0.4
printf "%-15s %-10s %s\n" "USER" "STATUS" "LAST ACTIVE"
printf '%0.s─' {1..44}; echo ""
printf "${CYAN}%-15s${NC} ${GREEN}%-10s${NC} %s\n" "alice" "idle" "4m ago"
printf "${CYAN}%-15s${NC} ${YELLOW}%-10s${NC} %s\n" "bob" "active" "just now"
sleep 2.5

echo ""

# ── Scene 2: narrate ─────────────────────────────────────────────────────────
fake_type "# next request will hit a rate limit..." 0.03
sleep 1.2

# ── Scene 3: request → 429 → pool failover ───────────────────────────────────
fake_type "CLAUDE_POOL_MOCK_429=1 curl -s localhost:8484/v1/messages -X POST \\" 0.03
sleep 0.1
printf "  -H 'Content-Type: application/json' \\\n"
sleep 0.1
printf "  -d '{\"model\":\"claude-opus-4-5\",\"max_tokens\":20,...}'\n"
sleep 0.6

printf "${GRAY}[proxy]${NC} → forwarding with own key\n"
sleep 0.5
printf "${YELLOW}[proxy]${NC} ← 429  retry-after=60s  benching own key\n"
sleep 0.4
printf "${CYAN}[proxy]${NC} ↓ borrowing idle key from alice\n"
sleep 0.5
printf "${GREEN}[proxy]${NC} ← 200 OK  (via pool)\n"
sleep 0.3
printf '%s\n' '{"content":[{"type":"text","text":"Hello! How can I help you today?"}]}'
sleep 2.5

echo ""

# ── Scene 4: status after failover ───────────────────────────────────────────
fake_type "claude-pool status"
sleep 0.4
printf "Agent:  bob (b3e2a1f0-…)\n"
printf "Status: ${YELLOW}cooling down${NC} (58s remaining)\n"
printf "Pool:   2 agents (1 idle)\n"
sleep 2

echo ""
printf "${GREEN}# session continued without interruption ✓${NC}\n"
sleep 1.5

# claude-pool demo tape
# Records a GIF showing transparent 429 failover in action.
#
# Prerequisites:
#   1. Install vhs:  brew install vhs
#   2. Start a local claude-pool server (docker compose up -d)
#   3. Start two agents:
#        Agent 1 (you): claude-pool start
#        Agent 2 (teammate sim): start a second agent with a different key registered
#   4. Record: vhs docs/demo.tape
#
# The demo uses CLAUDE_POOL_MOCK_429=1 to simulate a 429 without hitting
# real rate limits. The proxy will skip the own-key attempt on the next
# request and borrow from the pool instead.

Output docs/demo.gif

Set FontSize 14
Set Width 1000
Set Height 420
Set Theme "Dracula"
Set PlaybackSpeed 0.8

# Show pool — two teammates active
Type "claude-pool pool"
Enter
Sleep 2s

# Narrate what we're about to do
Type "# next request will hit a rate limit..."
Enter
Sleep 1s

# Trigger mock 429 — the proxy will skip own key and borrow from pool
Type "CLAUDE_POOL_MOCK_429=1 curl -s http://localhost:8484/v1/messages -X POST \\"
Enter
Type "  -H 'Content-Type: application/json' \\"
Enter
Type "  -H 'Authorization: Bearer test' \\"
Enter
Type "  -d '{\"model\":\"claude-opus-4-5\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' \\"
Enter
Type "  | jq .content[0].text"
Enter
Sleep 3s

# Show updated status — own key in cooldown, pool credential was used
Type "claude-pool status"
Enter
Sleep 2s

Type "# session continued without interruption"
Enter
Sleep 1.5s

# claude-pool demo tape
# Records the terminal GIF that goes in the README.
#
# Prerequisites:
#   brew install vhs
#
# Record:
#   vhs docs/demo.tape
#
# This tape uses scripts/demo-play.sh which simulates a real session
# (no running server or API keys required).

Output docs/demo.gif

Set FontSize 14
Set Width 900
Set Height 380
Set Theme "Dracula"
Set PlaybackSpeed 0.8
Set CursorBlink false

Hide
Type "cd /Users/arthur/git/startup/claude-pool"
Enter
Sleep 200ms
Show

Type "bash scripts/demo-play.sh"
Enter
Sleep 25s

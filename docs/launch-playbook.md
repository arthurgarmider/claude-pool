# claude-pool Launch Playbook

Status as of 2026-05-02:

- Package published: `@claudepool/agent` on npm
- Image published: `arthurga/claudepool` on Docker Hub (linux/amd64, linux/arm64)
- GitHub repo metadata: description, topics, homepage all set
- README has GIF, badges, quick-start

This playbook walks you through the launch day-by-day. Read it once top-to-bottom, then use it as your task list. Everything is sequenced to maximise the chance of hitting the HN front page.

---

## Day 0 — Today (Saturday May 2)

### 0.1 — Pin the repo to your GitHub profile (1 min)

1. Open <https://github.com/arthurgarmider>
2. Under "Pinned" click "Customize your pins"
3. Add `claude-pool`
4. Save

### 0.2 — Add a Docker Hub overview (3 min)

The Docker Hub page currently shows "No overview available". Fix it:

1. Open <https://hub.docker.com/r/arthurga/claudepool>
2. Click the pencil icon next to "Repository Overview"
3. Paste the contents of `docs/dockerhub-overview.md` (in this repo)
4. Save

### 0.3 — Sanity-check everything renders (5 min)

Open in incognito (so caching doesn't fool you):

- <https://github.com/arthurgarmider/claude-pool> — confirm the GIF plays, all 4 badges are green, the description shows under the repo name, the topics show below it
- <https://www.npmjs.com/package/@claudepool/agent> — confirm the README renders (will be cleaned up after the 0.1.1 republish, see 0.4)
- <https://hub.docker.com/r/arthurga/claudepool> — confirm the overview shows

### 0.4 — npm README cleanup (already done — v0.1.1 published)

The agent README's broken `YOUR_ORG/claude-pool` link is fixed in v0.1.1. Just verify at <https://www.npmjs.com/package/@claudepool/agent> that the "full documentation" link points to the real GitHub URL.

### 0.5 — Submit to awesome-lists (10 min)

These three lists are all PR-friendly and are read by exactly your target audience. Open each, look at how existing entries are formatted, and submit a PR.

1. **<https://github.com/hesreallyhim/awesome-claude-code>** — biggest of the three
2. **<https://github.com/jqueryscript/awesome-claude-code>**
3. **<https://github.com/webfuse-com/awesome-claude>**

Suggested entry text (adapt to each list's format):

```markdown
- [claude-pool](https://github.com/arthurgarmider/claude-pool) - Transparent rate-limit failover for Claude Code teams. Pool API keys across your team; when one teammate hits a 429, the next request silently borrows an idle key.
```

If a PR gets accepted before launch day, that's a free distribution channel.

---

## Day 1 — Sunday May 3 / Monday May 4

### 1.1 — Pre-launch warm-up (30 min)

Before you launch, a couple of "I'm building this" tweets / posts in adjacent communities establishes you as a real person, not a drive-by spammer. This makes the actual launch land softer.

**Twitter/X — pinned tweet on your profile:**

```
Building claude-pool: when your team hits a Claude Code rate limit, it
silently borrows an idle API key from a teammate so your session keeps
moving.

Open source, self-hosted, MIT.

Soft-launching this week 👀

github.com/arthurgarmider/claude-pool
```

**A reply-style post in r/ClaudeCode** — find a recent thread complaining about rate limits and post a helpful comment. Don't link the repo unprompted; if someone asks "how do you deal with this", *then* link it. This builds organic mentions before you formally launch.

### 1.2 — Block your launch slot in your calendar (1 min)

Optimal HN posting window for a Tuesday or Wednesday: **08:00–11:00 UTC**, which is:

- 04:00–07:00 US Eastern (best for the US audience)
- 11:00–14:00 Israel time (your timezone)

Recommended: **Wednesday May 6, 12:30 Israel time** (09:30 UTC, 05:30 ET). Captures EU mid-morning + US East Coast just-waking-up. Not so early that you can't be online to respond to comments.

Block 12:30 → 16:00 in your calendar — first 3 hours of HN responses are critical and you must be available to answer.

---

## Day 2 — Wednesday May 6 = LAUNCH DAY

This is the day. Run it like a campaign.

### 2.1 — T-30 min: final pre-flight (12:00 IL / 09:00 UTC)

```bash
# Verify CI is green and tag is correct
cd /Users/arthur/git/startup/claude-pool
git pull
gh run list --limit 3

# Verify install works on a fresh machine simulation
docker run --rm oven/bun:1 bash -c "bun install -g @claudepool/agent && claude-pool --help" 2>&1 | head -20
```

Expected: command list prints. If it errors, **DO NOT LAUNCH** — fix first.

### 2.2 — T-0: Submit Show HN (12:30 IL / 09:30 UTC)

Open <https://news.ycombinator.com/submit>

**Title** (54 chars, includes "open source" boost):

```
Show HN: Open-source 429 failover for Claude Code teams
```

**URL:** `https://github.com/arthurgarmider/claude-pool`

**Text** (paste in plain text, no Markdown — HN renders this):

```
We built claude-pool after our team kept losing Claude Code sessions
to 429s. One person hits a rate limit, their session stalls — annoying
when you're mid-flow.

claude-pool is a small proxy that sits between Claude Code and
Anthropic. When it sees a 429, it borrows an idle API key from a
teammate in the pool and retries the request. Your session continues
without interruption. No changes to your Claude Code workflow — just
set ANTHROPIC_BASE_URL to the proxy.

The server is self-hosted (docker compose up -d), open source (MIT),
and runs on any VPS. Each teammate installs a small Mac daemon that
registers their API key with the server and reports active/idle status.
Credentials are encrypted at rest with AES-256-GCM.

Demo GIF in the README. Happy to answer questions about the
architecture, the lease/cooldown semantics, or anything else.

GitHub: https://github.com/arthurgarmider/claude-pool
npm:    @claudepool/agent
Docker: arthurga/claudepool
```

Click submit. Note the post ID in the URL (`item?id=XXXXXXXX`).

### 2.3 — T+5 min: Cross-post to communities (12:35–13:00 IL)

Don't wait. The first 2 hours of HN votes determine front-page placement; you need amplification *now*.

**r/ClaudeCode** — <https://reddit.com/r/ClaudeCode/submit>

Title:
```
[Show] claude-pool — open-source rate-limit failover for Claude Code teams
```

Body:
```
Built this for our team after hitting too many 429s mid-session. It's
a small proxy that sits between Claude Code and Anthropic. When it
sees a 429, it borrows an idle API key from a teammate and retries —
your session keeps going.

- Self-hosted (Docker), MIT licensed
- Server: `docker compose up -d`
- Agent: `bun install -g @claudepool/agent`
- Demo GIF + full quick-start in the README

GitHub: https://github.com/arthurgarmider/claude-pool

Posted on HN too: [link to your HN submission]

Happy to answer questions or take feedback.
```

**r/ClaudeAI** — <https://reddit.com/r/ClaudeAI/submit> — same title and body.

**r/AI_Agents** — <https://reddit.com/r/AI_Agents/submit> — same.

**r/VibeCoding** — <https://reddit.com/r/VibeCoding/submit> — same.

### 2.4 — T+15 min: Discord seeding (12:45 IL)

Both servers have a #show-and-tell or #projects channel. Find it.

**Anthropic official Discord** — <https://discord.com/invite/6PPFFzqPDZ>

**Claude Developers Discord** — <https://discord.com/invite/prcdpx7qMm> (35k+ members — bigger reach)

Post (same in both):

```
Hey — just open-sourced claude-pool, a tool our team uses for
transparent rate-limit failover on Claude Code. Hit a 429? It borrows
a teammate's idle API key and your session keeps going.

Self-hosted, MIT, docker compose for the server. Demo GIF in the
README.

GitHub: https://github.com/arthurgarmider/claude-pool

Happy to answer questions.
```

### 2.5 — T+20 min: Twitter/X thread (12:50 IL)

Tweet 1 (the hook — keep it tight):
```
Open-sourced claude-pool today.

When your team hits a Claude Code rate limit, it silently borrows an
idle API key from a teammate so your session keeps moving.

Self-hosted. MIT. One docker compose command.

github.com/arthurgarmider/claude-pool
```

Tweet 2 (the GIF — drop into the thread):
```
[upload docs/demo.gif here]

Mock-429 demo: own key gets benched, pool credential takes over,
request succeeds. Zero workflow changes for the user — Claude Code
just keeps working.
```

Tweet 3 (the architecture — for engineers):
```
How it works:

• Each teammate runs a tiny Mac daemon
• Daemon proxies Claude Code's outbound traffic
• On 429: ask central server for an idle credential, retry, bench
  the rate-limited one for retry-after seconds
• Encrypted-at-rest with AES-256-GCM

Lease / cooldown logic in 200 lines of SQLite.
```

Tweet 4 (the call to action):
```
Show HN thread is live: [paste HN URL]

Would love feedback, especially from teams who've felt the
"one-teammate-blocks-everyone" 429 pain.
```

**Tag in tweet 1 (only one — don't spam):** `@AnthropicAI`

### 2.6 — T+30 min onward: BE PRESENT (13:00 IL → 16:00 IL)

This is the most important block. **Do not multitask.** Stay on HN and Reddit, refresh every few minutes, respond to every single comment.

**Comment response priorities:**

1. **Technical questions about architecture** — answer thoroughly. These get upvoted, which boosts the post.
2. **ToS / "is this allowed" concerns** — answer factually using the README's framing: API-key mode is standard multi-key load balancing (clean), OAuth mode is documented as experimental and gated.
3. **Feature requests** — acknowledge, ask for a GitHub issue. Don't promise.
4. **"This is just X but Y"** comparisons — engage genuinely. Don't get defensive. The reader watching the exchange is judging your maturity.
5. **Trolls** — ignore. Do not feed.

### 2.7 — T+3h: Mid-launch checkpoint (15:30 IL)

Around 3 hours in, the HN trajectory is clear. Either you're climbing the front page or you're not.

**If you're on the front page (top 30):**
- Keep responding
- Don't post anything else today (no second-channel bumps)
- Pin the HN URL in your Twitter bio

**If you're #50–100 on /new:**
- Post one targeted reply on the HN thread inviting questions ("Happy to dig into the lease semantics if anyone's curious")
- Tweet again referencing a specific question that came up
- Keep it light — no begging for upvotes

**If you flopped (no votes, low position):**
- Don't panic. ~70% of Show HNs flop.
- Don't repost — that's against HN rules and will hurt you long-term.
- Focus the rest of the day on the Reddit threads, which often get traction even when HN doesn't.

### 2.8 — End of day: tally & log (22:00 IL)

In a private file:

```
Launch day: 2026-05-06
HN points at EOD: ___
HN comments: ___
HN ranking: ___
Reddit points (sum): ___
GitHub stars EOD: ___ (was 0 at start)
GitHub clones / unique visitors (Insights tab): ___
npm weekly downloads (npmjs.com/package): ___
Docker pulls: ___
```

This baseline matters for your week 2/3 follow-up content.

---

## Days 3–7 — Sustain (May 7 → May 10)

### 3.1 — Daily HN check-in

Each morning, check the HN thread. Late-arriving comments often deserve a reply even days later. This shows the project is maintained and the author is real.

### 3.2 — Day 4: respond to early issues / PRs

If anyone files an issue or PR, respond within 24h. Even a "thanks, looking into this" reply within a few hours converts a casual visitor into a return visitor.

### 3.3 — Day 7: write blog post #1

Topic: "How we swallow Claude Code 429s transparently" — the proxy mechanism deep-dive.

Outline:
1. The pain: shared team rate limits stall everyone when one person hits 429
2. The naive fix: rotate API keys manually (doesn't scale, easy to forget)
3. The transparent fix: ANTHROPIC_BASE_URL points to a local proxy
4. The proxy logic: own-key first, on 429 → borrow from pool → retry
5. The lease semantics: cooldown windows from Retry-After, accumulated request count, expiry on TTL
6. Code walkthrough of `packages/agent/src/proxy.ts` (it's only 254 lines)
7. What's next: real-time pool status, Linux agent, hosted version?

Length: 1500–2500 words. Cross-post:
- HN as a follow-up "Show HN" (allowed for content posts)
- r/programming
- r/ClaudeAI
- dev.to
- Your personal blog if you have one

---

## Week 2 (May 11 → May 17)

### 4.1 — Blog post #2

Topic: "Building a distributed credential pool in 200 lines of SQLite"

Audience: distributed-systems-curious developers (a much wider audience than just Claude Code users). Makes the project visible to a new pool of people who'll star "for the engineering" even if they don't use Claude Code.

Walk through `packages/server/src/store.ts` — lease arbitration, expiry handling, the audit log, why SQLite was the right choice over Postgres.

### 4.2 — Influencer DMs (5 only — quality > quantity)

DM five accounts. **Personalised** message — mention something specific they've posted recently. No "would you like to retweet" asks.

Targets (in priority order):
1. **@emollick (Ethan Mollick)** — most influential AI commentator, frequently shares concrete dev tools. He's posted positively about Claude Code multiple times.
2. **@hannahstulberg (Hannah Stulberg)** — building Team OS workflows on Claude Code; the "team coordination" angle of claude-pool is exactly her interest.
3. **@aakashg0 (Aakash Gupta)** — covers product/team workflows on Claude Code.
4. **@milesdeutscher** — AI trends commentator, bigger general audience.
5. **One person from your own network** — a known dev who might genuinely benefit and whose share carries authentic weight.

DM template:

```
Hey [Name], saw your post on [specific recent thing they wrote about].

Built a small open-source thing for Claude Code teams that you might
find interesting: claude-pool — when your team hits a 429, it
transparently borrows an idle API key from a teammate so the session
keeps going.

Demo GIF + repo here: github.com/arthurgarmider/claude-pool

No ask — just thought it might land with the kind of folks you write
for. Happy to answer any questions.
```

Send these *spread across the week*, not all at once.

---

## Week 3 (May 18 → May 24)

### 5.1 — Blog post #3

Topic: "What we learned from our first N users of claude-pool" — replace N with whatever the actual number is (50? 200?).

This is the single highest-converting type of dev-tool post. Real numbers, real surprises, real iteration.

Required content:
- Actual usage numbers
- 2–3 things that surprised you
- 1 thing you got wrong and fixed
- 1 thing users asked for that you'd love help with (recruits contributors)

### 5.2 — File a tracking issue inviting contributors

Title: `Good first issues for new contributors`

Body: list 5–10 small, well-scoped contribution opportunities (Linux agent, alternative auth providers, observability hooks, etc.). This is a free dual-purpose: it shows momentum to drive-by visitors AND it actually pulls in contributors.

---

## Week 4 (May 25 → May 31)

### 6.1 — SEO content

Single static page or blog post targeting `Claude Code rate limit` and `Claude Code 429 error` searches.

Title: "How to handle Claude Code rate limits in a team"

Structure:
1. Why teams hit 429s (shared org-level quota, parallel usage spikes)
2. Anthropic's recommended approach (multiple workspace seats — link their docs)
3. The gap: workspace seats don't help if one teammate is in a long agentic session
4. claude-pool as the gap-fill solution
5. Quick-start

Submit to a few SEO-friendly aggregators (dev.to, hashnode, your own blog with proper schema markup).

### 6.2 — Set up GitHub Sponsors

1. <https://github.com/sponsors>
2. Click "Set up GitHub Sponsors"
3. Add a $1 / $5 / $25 / $100 tier
4. The "Sponsor" button now appears on your repo — adds credibility, signals long-term project

### 6.3 — Anthropic outreach

Now that you have stars + real users, engage with Anthropic directly:
1. File an issue / discussion in <https://github.com/anthropics/anthropic-sdk-typescript> (or similar) asking about formal multi-key pooling guidance
2. Apply to the Claude developer program or any partner program they offer
3. Mention claude-pool in their Discord's relevant channel

The goal isn't to get an endorsement — it's to be on their radar. Anthropic engineers occasionally feature community projects in roundups.

---

## Anti-patterns — DO NOT DO THESE

- **Don't repost on HN if the launch flops.** It'll hurt your account permanently.
- **Don't beg for upvotes.** Every "please upvote" comment is a downvote magnet.
- **Don't argue with critics.** Engage thoughtfully or ignore. Defensive replies are visible to everyone.
- **Don't add features in response to one HN comment.** Wait for patterns. Random feature additions in week 1 confuse the project's identity.
- **Don't respond to "is this against ToS" with anything other than the README's exact framing.** Stay calm, factual, point at the existing documentation.
- **Don't hype.** "AI-powered" gets a -15% score on HN. "Game-changing" too. Plain technical language always wins.

---

## Success thresholds

| Metric | Floor (acceptable) | Target | Stretch |
|---|---|---|---|
| Day 1 GitHub stars | 30 | 100 | 500+ |
| Week 1 stars | 75 | 250 | 1000+ |
| Week 4 stars | 150 | 500 | 2500+ |
| HN points (peak) | 20 | 80 | 200+ |
| Reddit points (sum across subs) | 20 | 100 | 300+ |
| npm weekly downloads (week 1) | 50 | 250 | 1000+ |
| Docker pulls (week 1) | 20 | 100 | 400+ |
| External blog mentions / week 4 | 1 | 3 | 10+ |
| GitHub issues opened by strangers (week 4) | 1 | 5 | 15+ |

If you're at "floor" — the launch was a normal soft launch, the project has a foothold but isn't viral. Keep shipping content.

If you're at "target" — you've successfully entered the niche. The project will compound.

If you're at "stretch" — congrats, claude-pool is a known name in Claude Code tooling. Time to think about whether to keep it as a side project or build a sustainable open-source sponsorship around it.

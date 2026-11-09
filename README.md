# Huddle

A shared idea memory for a group of friends who work with coding agents.

Creative ideas come from people. When you think something through with your agent, the goal and the decisions you reach can help a friend working on something related. Huddle lets your agent borrow those perspectives **when you ask**. It never fills your chat with everything your friends did.

- **Share:** in any chat, say `/huddle connect`. From then on, a scheduled routine on your computer writes down that chat's goal and decisions and pushes them here. Nothing else leaves your computer.
- **Ask:** say "see what everyone thinks". A separate scout reads your friends' entries, keeps only what helps your current goal, and hands back at most 3 perspectives, or says nothing helped.

Works with Claude Code and Codex, on macOS, Linux and Windows (Windows untested).

## Join (for friends)

1. Accept your invite: https://github.com/tsegaat/huddle-brain/invitations
2. Paste the prompt at the bottom of [JOIN.md](JOIN.md) into Claude Code or Codex. It installs everything it needs and tells you when it needs you (a GitHub login in your browser, or your password for an install).

You need a GitHub account and Claude Code (the desktop app's Code tab is fine) or Codex. Nothing else to set up beforehand.

## Add a friend (for whoever runs the repo)

Say "huddle invite THEIR_GITHUB_USERNAME" in any chat, or run:

```
node ~/.huddle/brain/huddle/huddle.mjs invite THEIR_GITHUB_USERNAME
```

It sends the GitHub invite and prints a message to send them (the text of [JOIN.md](JOIN.md)). Edit JOIN.md to change that message.

## Use it

| Say this in a chat | What happens |
|---|---|
| `/huddle connect` (or "huddle setup this chat") | This chat starts being shared. The routine shares it every 30 minutes, once the chat has been quiet for 10 minutes. |
| "see what everyone thinks" (or `/huddle` + a question) | Your agent writes a 3-line brief (goal, current direction, what's unsure) and gets back friends' perspectives. |
| "huddle sync now" | Share connected chats right away. |
| `/huddle status` | What's set up and connected. |
| `/huddle disconnect` | Stop sharing this chat. Its entry stays until you delete the file. |

In Codex, say the phrase in plain words (for example "huddle setup this chat").

## How it works

```
 Chat you connected                          Your chat: "see what everyone thinks"
        |                                              |
 routine (every 30 min, on your computer)       your agent writes a 3-line brief
 reads the chat, writes goal + decisions               |
        |                                       scout (separate process, its own context)
 git push --->  this repo: entries/<person>/*.md  <---  1. git pull
                                                         2. read every goal line
                                                         3. open only entries whose goal lines up
                                                         4. keep decisions that help or challenge you
                                                               |
                                               up to 3 perspectives, or "nothing useful"
```

- **One file per shared chat** (`entries/<person>/<date>-<goal>.md`), so two friends pushing at once never conflict.
- **Goal first, then decisions.** The scout reads all the one-line goals, opens only the entries that line up, and judges their decisions against your brief. Everything it reads and discards stays out of your chat.
- **Uses the agent you already have.** The routine and the scout call `claude -p` or `codex exec` with your existing login. No API keys, no server.
- **Updates itself.** Each routine run pulls this repo and refreshes the skill, so changes pushed here reach everyone.

An entry looks like this:

```markdown
---
author: alice
date: 2026-11-05
updated: 2026-11-07
goal: Get people to open my habit app every day without nagging them
tags: [habits, motivation, mobile-app]
chat: 3f9a1c0b2d
---

## Goal
Get people to open the app daily without it feeling like a chore.

## Decisions
1. **Weekly streaks instead of daily streaks.**
   Why: a daily streak breaks on one missed day, and people quit after losing it.
   Instead of: daily streaks with "freeze" tokens (felt like a chore to manage).

## Still open
- Does a weekly streak feel too easy for power users?
```

## What gets shared, and what doesn't

- Only the goal, the decisions with their reasons, and open questions. No code, no transcript.
- Secrets (API keys, tokens, passwords, private keys) and email addresses are removed twice: from the chat before the model reads it, and from the entry before it's pushed.
- Work topics are described in general terms; company names, internal systems and customer data are left out.
- There is no review step before a push. You choose which chats to connect, and you can delete or edit any entry file here at any time.
- Everyone in this repo can read every entry.
- Whoever can push code here can change what runs on everyone's computer (the routine updates itself). Only invite people you trust.

## Commands

The skill runs these for you; you can also run them in a terminal.

```
node ~/.huddle/brain/huddle/huddle.mjs status
node ~/.huddle/brain/huddle/huddle.mjs sync --now
node ~/.huddle/brain/huddle/huddle.mjs invite GITHUB_USERNAME
node ~/.huddle/brain/huddle/huddle.mjs uninstall
```

The routine's log is at `~/.huddle/logs/sync.log`.

## Known limits

- Only chats on your own computer can be connected: Claude Code and Codex, not the claude.ai or ChatGPT apps, and not cloud sessions.
- The routine runs only while your computer is on and you're logged in.
- The scout reads every goal line on each ask. That's fine for hundreds of entries; at thousands it will need a topic filter.
- An entry is only as good as the chat. If a chat never settles on a goal or decisions, nothing is shared from it.
- Each consult makes two model calls and takes about 30 to 90 seconds.

## Developing

```
npm test
```

The tests use a bare git repo in place of GitHub, separate home folders for each simulated friend, and a stand-in model (`huddle/test/fake-llm.mjs`). Nothing to install: only Node 20+ and git.

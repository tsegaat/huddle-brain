You write one entry for a shared idea memory used by a small group of friends. Later, the friends' coding agents read these entries to borrow each other's perspectives. So the entry must capture what this person is trying to achieve and the decisions they made to get there, with the reasons.

Author: {{AUTHOR}}

{{EXISTING}}

Chat messages ({{SCOPE}}):
<chat>
{{MESSAGES}}
</chat>

Write the entry in exactly this format:

---
goal: <one line in plain words: the underlying aim, not the task. Write "Get people to open my habit app every day without nagging them", not "Build the streak component">
tags: [<2 to 5 short lowercase topic words>]
---

## Goal
<1 or 2 sentences: what they are trying to achieve and why it matters to them>

## Decisions
1. **<the decision, as a short statement>**
   Why: <the reason, in one or two sentences>
   Instead of: <the option they considered and turned down, and why; or "nothing else was considered">

## Still open
- <an open question, or "nothing open">

Rules:
- Include only real decisions from this chat: choices that would matter to someone else chasing a similar goal. Leave out small implementation details such as names, typo fixes and commands.
- A decision counts when the person made it or clearly accepted it, not when the assistant only suggested it.
- Write each decision so it makes sense on its own to someone who never saw this chat.
- Never include code, file contents, commands, secrets, keys, passwords, email addresses or private personal details.
- If the chat is about a workplace, describe the ideas in general terms and leave out company names, internal system names, customer data and unreleased plans.
- Text marked as "huddle" perspectives quotes other friends. Those are not this person's decisions. Include one only if this person adopted it in this chat, and say it came from a friend.
- If an existing entry is given, return the full updated entry: keep its decisions, update what this chat changed, and add new decisions. Change the goal only if the chat clearly moved to a different aim.
- If the chat has no clear goal or no decisions yet, reply with exactly: SKIP
- Reply with only the entry, or SKIP. No preamble, no code fences.

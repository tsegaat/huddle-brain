Set up Huddle on this computer for me.

Huddle is a shared idea memory for me and my friends. A scheduled routine on this computer shares the goal and decisions from the chats I connect to our private GitHub repo, https://github.com/tsegaat/huddle-brain. When I ask "see what everyone thinks", I get my friends' perspectives on what I'm working on.

Do these steps in order. If a step fails, stop and tell me exactly what to do. These steps use the network and write outside the current folder; if your sandbox blocks them, ask me to allow them.

1. Check that `git` and Node.js 20 or newer are installed (`git --version`, `node --version`). Install whichever is missing.
2. Check that I can reach the repo: `GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/tsegaat/huddle-brain`.
   If that fails, I'm either not logged in to GitHub or haven't accepted my invite to the repo. If the GitHub CLI is installed, run `gh auth status`; if I'm logged in, run `gh auth setup-git` and try again. Otherwise tell me to accept the invite (github.com/tsegaat/huddle-brain/invitations) and log in with `gh auth login`.
3. Get the repo: if `~/.huddle/brain` exists, run `git -C ~/.huddle/brain pull`. Otherwise run `git clone https://github.com/tsegaat/huddle-brain ~/.huddle/brain`.
4. Run `node ~/.huddle/brain/huddle/huddle.mjs install --llm <claude or codex: whichever agent you are>`.
   This installs the huddle skill and creates the scheduled routine (every 30 minutes, on this computer).
   If it says it couldn't create the routine, create a scheduled routine on this computer yourself that runs the command it prints every 30 minutes.
5. Show me what it printed, then tell me in two lines how to use it: "/huddle connect" in a chat to start sharing that chat, and "see what everyone thinks" to get my friends' perspectives.

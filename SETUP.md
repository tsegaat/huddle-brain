Set up Huddle on this computer for me.

Huddle is a shared idea memory for me and my friends. A scheduled routine on this computer shares the goal and decisions from the chats I connect to our private GitHub repo, https://github.com/tsegaat/huddle-brain. When I ask "see what everyone thinks", I get my friends' perspectives on what I'm working on.

Do these steps in order and keep me posted in one short line per step. These steps use the network and write outside the current folder; if your sandbox blocks them, ask me to allow them. If a step needs my password or a browser login, give me the exact command to run in my own terminal, wait for me to say it's done, then carry on. If a step fails in a way you can't fix, stop and tell me exactly what to do.

1. **Tools.** Check for `git`, Node.js 20 or newer, and the GitHub CLI: `git --version`, `node --version`, `gh --version`. Install whatever is missing or too old:
   - Mac with Homebrew (`brew --version` works): `brew install git node gh`.
   - Mac without Homebrew: ask me to install Homebrew from https://brew.sh (it asks for my password), then use it.
   - Linux: use the system package manager (Node from https://nodejs.org if the packaged one is older than 20; gh from https://cli.github.com).
   - Windows: `winget install Git.Git OpenJS.NodeJS.LTS GitHub.cli`.
2. **GitHub login.** Run `gh auth status`. If I'm not logged in, ask me to run `gh auth login` in my own terminal (choose GitHub.com, HTTPS, and log in with a browser). Then run `gh auth setup-git` so git can use that login.
3. **Access.** Run `GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/tsegaat/huddle-brain`.
   If it fails, I probably haven't accepted my invite: ask me to open https://github.com/tsegaat/huddle-brain/invitations and accept it. If there's no invite there, ask me to send my GitHub username (`gh api user --jq .login`) to the friend who sent me Huddle so they can invite me.
4. **Get the repo.** If `~/.huddle/brain` exists, run `git -C ~/.huddle/brain pull`. Otherwise run `git clone https://github.com/tsegaat/huddle-brain ~/.huddle/brain`.
5. **Install.** Run `node ~/.huddle/brain/huddle/huddle.mjs install --llm <claude or codex: whichever agent you are>`. It takes up to a few minutes because it checks that the model answers.
   - If it says Claude Code didn't answer: install the Claude Code command with `curl -fsSL https://claude.ai/install.sh | bash` (Windows: `irm https://claude.ai/install.ps1 | iex`), ask me to run `claude` once in my own terminal and log in, then run the install again.
   - If it says Codex didn't answer: ask me to run `codex` once in my terminal and log in. If Codex needs a specific model, add `--model <name>` and run the install again.
   - If it says it couldn't create the routine, create a scheduled routine on this computer yourself that runs the command it prints every 30 minutes.
6. **Done.** Show me what the install printed, then tell me in three lines:
   - Start a new chat so the huddle skill loads.
   - In any chat worth sharing, say "/huddle connect".
   - When I want my friends' take, say "see what everyone thinks".

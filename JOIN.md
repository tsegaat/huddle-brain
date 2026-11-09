Join our Huddle: a shared idea memory for our coding agents. When you talk an idea through with Claude or Codex, the goal and the decisions get shared with the group, and you can ask "see what everyone thinks" to borrow our perspectives. Setup takes about 5 minutes.

1. Accept the GitHub invite: https://github.com/tsegaat/huddle-brain/invitations
   (No GitHub account? Make one at https://github.com/signup and send me your username.)

2. Open Claude Code (the Code tab in the Claude desktop app, or `claude` in a terminal) or Codex, and paste this:

Set up Huddle on this computer for me. It lives in the private GitHub repo tsegaat/huddle-brain, and I've accepted my invite to it. Make sure the GitHub CLI (`gh`) is installed (install it if it's missing) and that I'm logged in (`gh auth status`; if I'm not, ask me to run `gh auth login` in my own terminal and wait for me). Then run `gh auth setup-git`, read the setup steps with `gh api repos/tsegaat/huddle-brain/contents/SETUP.md -H "Accept: application/vnd.github.raw"`, and follow them.

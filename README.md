<p align="center">
  <img src="assets/logo.svg" alt="Subagents Panel logo" width="128" height="128">
</p>

<h1 align="center">Subagents Panel</h1>

<p align="center">
  See what your Claude Code subagents are doing, live, in a side panel.<br>
  Works in the Claude Code CLI and in the Claude desktop app.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Claude Code mod" src="https://img.shields.io/badge/Claude%20Code-mod-D97757.svg">
</p>

---

When Claude hands work to subagents, they run out of sight. **Subagents Panel** gives each one a
place you can watch: what it is doing right now, every step it takes, how long it has been running,
and the report it hands back. You can even send it a message while it works.

<!-- Screenshots go here. -->

## Features

- **A live overview.** Every subagent in the session, grouped into **In progress** and
  **Completed**. Running ones show a one-line summary of what they are doing right now.
- **Step-by-step detail.** Click an agent to see its narration and its tool calls, folded into
  groups like *"Read 3 files, ran 2 commands"*, with the final report at the end.
- **Talk to a running agent.** A message box at the foot of a running agent's detail view sends
  your words straight to that agent. They show up in its timeline as **You → …**.
- **A status band above the prompt.** How many agents are running or done, their avatars (stacked
  with **+N** when there are many), and an **Open subagents** button. Close it with **×**.
- **Search.** Filter the overview by name, type, current activity, task or report as you type.
- **Live timers.** Elapsed times keep ticking, even while an agent sits waiting on its own work.
- **A unique avatar for every agent.** Each agent's id seeds its own shape and colors, so you can
  tell agents apart at a glance, in the same look every time.
- **Colored tool icons.** Blue for file work, green for commands, purple for everything else.
- **Survives a restart.** Resume a session and the panel rebuilds its list from the transcript.
- **Light and dark themes**, on both the CLI and the desktop app.

## Install

You need [Claude Code](https://claude.com/claude-code). In a Claude Code session in your
terminal, type:

```
/plugin install subagents-panel --marketplace berkakkaya/subagents-panel
```

Answer `y` to add the marketplace, then pick a scope. Choose **user** to have the panel in every
session, including sessions you start from the Claude desktop app.

That's it: the next time Claude starts a subagent, the panel opens by itself.

### Updating

```
claude plugin update subagents-panel
```

Then run `/reload-plugins` in any open session, or start a new one.

### Uninstalling

```
claude plugin uninstall subagents-panel
```

## Using it

| To | Do this |
| --- | --- |
| Open the panel | It opens by itself when a subagent starts. Or type `/subagents`. |
| See an agent's progress | Click its name in the overview. Click **←** to go back. |
| Hide or show a section | Click **In progress** or **Completed**. |
| Find an agent | Type in the search box at the top of the overview. |
| Message a running agent | Open it, click the message box at the bottom, type, press **Enter**. |
| Start a new line in a message | **Shift+Enter** on desktop. In a terminal: **Ctrl+J**, or `\` then **Enter**. |
| Hide the band above the prompt | Click **×** on its right. Type `/subagents` to bring it back. |

The message box sits under agents that are still running (or waiting on their own work); finished
agents have no box. A message reaches the agent the same way Claude's own SendMessage tool would,
and the agent reads it at its next step.

## Troubleshooting

**The panel does not open.** Type `/subagents`. If the reply says the panel is open but not shown,
it gives the reason. In a terminal, a panel that opens by itself needs a window at least 144
columns wide; `/subagents` opens it at any width.

**A click does not seem to register, or a timer looks stuck.** Type `/subagents debug`. It prints
when the elapsed times last moved and the panel's last renders, focus changes and presses, with
timings. Please include that output when you open an issue.

**Message box keys in a terminal.** Most terminals send Shift+Enter the same as Enter, so use
**Ctrl+J** (or `\` then **Enter**) for a new line.

## Contributing

Contributions are welcome: bug reports, ideas and pull requests.

### Getting set up

1. Fork the repository and clone your fork.
2. Load the mod from your working copy for a Claude Code session:

   ```
   claude --plugin-dir /path/to/subagents-panel
   ```

   Claude Code watches the folder and reloads the mod when you save a file. The first load also
   writes the API's type declarations into `.claude-plugin/types/` (ignored by git), which your
   editor and `tsc` use.

### Project layout

| Path | What it is |
| --- | --- |
| `hooks/register.tsx` | The mod: event hooks, state, the panel, the band, delivery of messages. |
| `hooks/elapsed.tsx` | A surface module: the live elapsed-time readout. |
| `hooks/composer.tsx` | A surface module: the multi-line message box. |
| `types/index.d.ts` | The shape of the state the mod keeps. |
| `tests/panel.test.tsx` | Tests, run on both the terminal and desktop surfaces. |
| `assets/` | The logo and screenshots. |

### Before you open a pull request

Run these from the project folder; all three should pass.

```
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```

- Keep changes working on **both** surfaces. Tests mount the panel on `terminal` and `desktop`;
  add a test for any behavior you add or fix.
- Match the style of the surrounding code: short functions, comments that say *why*.
- Describe what you changed and how you checked it. A screenshot helps for anything visual.

### Reporting a bug

Open an issue with what you did, what you expected, what happened, whether it was the CLI or the
desktop app, and the output of `/subagents debug`.

## License

[MIT](LICENSE)

---

<p align="center">
  © 2026 Berk Akkaya<br>
  <a href="https://cyberk.dev/">cyberk.dev</a>
</p>

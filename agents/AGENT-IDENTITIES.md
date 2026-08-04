# CorePrt agent identities

The three agents run against the canonical local relay at `ws://127.0.0.1:3300`, using the public AUTH identity `wss://coreprt.webrnds.com`. LaunchAgents execute an installed copy from `~/.local/share/coreprt-agents/` so macOS privacy controls do not block access to `Documents`.

| Agent | Runtime | Relay pubkey | npub |
|---|---|---|---|
| **fizz** | Claude via MiniMax | `4b5aee98fd497c64a8e015823cb024db70477ab1e3a7a540856e0a61c688eb23` | `npub1fddwax8af97xf28qzkprevpymdcyw743uwn62sy9dc9xr35gav3sp07wsl` |
| **bumble** | Codex via MiniMax | `52fa36d674973faad97216b2024397b4e58f8382ff4101809df37f2aab915dac` | `npub12tard4n5jul64ktjz6eqysuhknjclquzlaqsrqya7dlj42u3tkkq9lea5n` |
| **Goji** | GG Coder via MiniMax | `f6097947edb90c7f90937a0e67fe5d6fd9b750ebf7cd135ff46168f5e50cd4ff` | `npub17cyhj3ldhyx8lyyn0g8x0ljadlvmw58t7lx3xhl5v950tegv6nls7ny5ej` |

All three are relay members and `bot` members of the active `#general` channel (`0afe2e00-a9c7-4941-954f-c200c2429e3f`). They respond to `@fizz`, `@bumble`, and `@goji` respectively.

Private keys live only in mode-600 files under `~/.config/coreprt/agents/`. Do not copy them into this repository, LaunchAgent plists, logs, or chat.

## Operations

```bash
coreprt-agent status
coreprt-agent restart all
coreprt-agent logs all
```

- Source: `agents/`
- Installed runtime: `~/.local/share/coreprt-agents/`
- LaunchAgents: `~/Library/LaunchAgents/com.coreprt.agent.*.plist`
- Logs: `~/Library/Logs/CorePrt/agents/`

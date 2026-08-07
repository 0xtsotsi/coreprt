// dispatch.mjs — operator-facing one-shot for the dispatch layer.
//
// Usage:
//   coreprt-agent dispatch <agent>                    # show the agent registry
//   coreprt-agent dispatch <agent> inspect            # show agents.json path + summary
//   coreprt-agent dispatch <agent> resolve --tag scope=marketing
//                                       --tag assign=goji
//                                       --content "@bumble build"
//                                       --kind 9
//   coreprt-agent dispatch <agent> test              # exercise all 7 rules with
//                                                    # canned events and print outcomes
//
// The <agent> positional is required by the coreprt-agent.sh dispatch table
// but is otherwise unused — the dispatch surface is global. We accept the
// arg so the CLI shape stays consistent with the other one-shots.

import { resolveAgentForEvent, _internals } from "../dispatch.mjs";

const args = process.argv.slice(2);
const agentName = args[0]; // unused at runtime; required by coreprt-agent.sh
const subcommand = args[1] ?? "show";

function parseFlags(rest) {
  const tags = [];
  let content = "";
  let kind = 9;
  let pubkey = "5" + "0".repeat(63);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--tag") {
      const kv = rest[++i] ?? "";
      const idx = kv.indexOf("=");
      if (idx < 0) {
        console.error(`bad --tag value (expected key=value): ${kv}`);
        process.exit(64);
      }
      tags.push([kv.slice(0, idx), kv.slice(idx + 1)]);
    } else if (a === "--content") {
      content = rest[++i] ?? "";
    } else if (a === "--kind") {
      kind = Number(rest[++i] ?? 9);
    } else if (a === "--pubkey") {
      pubkey = rest[++i] ?? pubkey;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      printHelp();
      process.exit(64);
    }
  }
  return { tags, content, kind, pubkey };
}

function printHelp() {
  console.log(`usage: coreprt-agent dispatch <agent> <subcommand> [flags]

subcommands:
  show                (default) print the loaded agent registry
  inspect             print registry path, version, and a summary
  resolve             resolve which agent handles a synthetic event
  test                exercise all 7 routing rules with canned events

flags for resolve:
  --tag key=value     add a tag (repeatable)
  --content "..."     set the event content
  --kind N            set the event kind (default 9)
  --pubkey <hex>      set the event pubkey
`);
}

if (!agentName) {
  printHelp();
  process.exit(64);
}
if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
  printHelp();
  process.exit(0);
}

if (subcommand === "show") {
  const reg = _internals.loadRegistry();
  console.log(JSON.stringify(reg, null, 2));
  process.exit(0);
}

if (subcommand === "inspect") {
  const reg = _internals.loadRegistry();
  console.log(`registry: ${_internals.REGISTRY_PATH}`);
  console.log(`version:  ${reg.version}`);
  console.log(`agents:   ${reg.agents.length}`);
  for (const a of reg.agents) {
    console.log(`  - ${a.name.padEnd(10)} role=${a.role.padEnd(12)} scopes=[${a.scopes.join(", ")}] trigger=${a.trigger}`);
  }
  console.log(`aliases:  ${Object.keys(reg.scopeAliases ?? {}).length}`);
  console.log(`unrouted: ${reg.unrouted}`);
  process.exit(0);
}

if (subcommand === "resolve") {
  const { tags, content, kind, pubkey } = parseFlags(args.slice(2));
  const event = {
    id: "synthetic",
    pubkey,
    kind,
    content,
    tags,
  };
  const r = resolveAgentForEvent(event);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

if (subcommand === "test") {
  const cases = [
    { name: "scope=marketing", event: { id: "1", pubkey: "5" + "0".repeat(63), kind: 9, content: "", tags: [["scope", "marketing"]] } },
    { name: "scope=web", event: { id: "2", pubkey: "5" + "0".repeat(63), kind: 9, content: "", tags: [["scope", "web"]] } },
    { name: "scope alias landing-page-v2", event: { id: "3", pubkey: "5" + "0".repeat(63), kind: 9, content: "", tags: [["scope", "landing-page-v2"]] } },
    { name: "@goji mention", event: { id: "4", pubkey: "5" + "0".repeat(63), kind: 9, content: "hey @goji", tags: [] } },
    { name: "bar=thecardyard-home", event: { id: "5", pubkey: "5" + "0".repeat(63), kind: 9, content: "draft", tags: [["bar", "thecardyard-home"]] } },
    { name: "assign=goji (no @mention)", event: { id: "6", pubkey: "5" + "0".repeat(63), kind: 9, content: "no mention", tags: [["assign", "goji"]] } },
    { name: "bare message", event: { id: "7", pubkey: "5" + "0".repeat(63), kind: 9, content: "thoughts?", tags: [] } },
  ];
  let pass = 0, fail = 0;
  for (const c of cases) {
    const r = resolveAgentForEvent(c.event);
    const line = `  ${c.name.padEnd(40)} -> ${r.agent} (${r.route})`;
    console.log(line);
    if (r.agent) pass++; else fail++;
  }
  console.log(`\n${pass}/${cases.length} resolved; ${fail} unrouted`);
  process.exit(fail === 0 ? 0 : 1);
}

console.error(`unknown subcommand: ${subcommand}`);
printHelp();
process.exit(64);

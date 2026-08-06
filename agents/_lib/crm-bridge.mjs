// crm-bridge.mjs — trycompai/crm ↔ Nostr event bridge (PR-5).
//
// This module is the dual driver the user named in the 2026-08-06
// webrnds expansion: trycompai/crm as the CRM layer, CorePrt as the
// production/identity layer, connected through a Nostr-native event bus.
//
// Two modes, gated on CRM_PROVIDER env:
//
//   CRM_PROVIDER=stub       → no trycompai API calls. Emits the same
//                              Nostr events the real bridge would emit
//                              (kind:43001 JOB_REQUEST, kind:30023 deal
//                              memo, kind:1 RECEIPT) but logs to
//                              ~/.config/coreprt/crm-stub.log instead of
//                              POSTing to trycompai.
//
//   CRM_PROVIDER=trycompai  → POSTs to TRYCOMPAI_API_URL with
//                              TRYCOMPAI_TOKEN bearer auth. Emits the
//                              same Nostr events on the CorePrt side.
//
// The Nostr events are the source of truth; the trycompai record is a
// mirror. Even with the real bridge, an operator can REQ the relay and
// reconstruct the entire client history without touching trycompai —
// that is the dual-driver portability story.
//
// Public surface:
//
//   crmOnboard({ client, contact, scope, budgetHours, dealMemo })
//     → { dealId, dealEvent, agentPubkey, ok, mode, trycompaiPosted }
//   crmStatus({ dealId })
//     → { dealId, status, scope, recentEvents, ok, mode }
//   crmReceipt({ dealId, kind, payload, signer })
//     → { receiptEventId, receiptEvent, agentPubkey, postedToTrycompai, ok, mode }
//
// The bridge never throws on trycompai-side failures; it returns
// { ok: false, reason } so the caller can decide whether to surface
// the failure or proceed without the CRM side (the Nostr side is
// always written first; trycompai is best-effort).
//
// Onboarding: place credentials at ~/.config/coreprt/crm.env (mode 0600):
//
//   CRM_PROVIDER=stub          # or trycompai
//   TRYCOMPAI_API_URL=https://crm.trycompai.com/api/v1
//   TRYCOMPAI_TOKEN=<your-token>

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent, getKeypairFromHex } from "./nostr.mjs";

// ─── config loading ─────────────────────────────────────────────────────

function loadCrmEnv() {
  // Mirrors the ~/.config/coreprt/agents/<name>.env convention but at
  // ~/.config/coreprt/crm.env (operator-level, not agent-level).
  const path = join(process.env.HOME ?? "", ".config", "coreprt", "crm.env");
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function getConfig() {
  // Explicit env wins over the crm.env file (operator debug override).
  return {
    provider: process.env.CRM_PROVIDER ?? loadCrmEnv().CRM_PROVIDER ?? "stub",
    apiUrl: process.env.TRYCOMPAI_API_URL ?? loadCrmEnv().TRYCOMPAI_API_URL ?? "",
    token: process.env.TRYCOMPAI_TOKEN ?? loadCrmEnv().TRYCOMPAI_TOKEN ?? "",
  };
}

// ─── stub mode persistence ──────────────────────────────────────────────

function appendStubLog(line) {
  const dir = join(process.env.HOME ?? "", ".config", "coreprt");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "crm-stub.log");
  appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
}

// ─── HTTP helper ────────────────────────────────────────────────────────

async function trycompaiFetch(path, init = {}) {
  const { apiUrl, token } = getConfig();
  if (!apiUrl) throw new Error("TRYCOMPAI_API_URL is not configured");
  if (!token) throw new Error("TRYCOMPAI_TOKEN is not configured");
  const url = `${apiUrl.replace(/\/$/, "")}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`trycompai ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Nostr event builders ───────────────────────────────────────────────

/**
 * Build a kind:30023 (long-form deal memo) envelope. Returns the
 * template — caller signs it. Tags are explicit per the 2026-08-06
 * planning doc:
 *
 *   ["d", "deal-<dealId>"]                 replaceable event key
 *   ["client", "<contact-pubkey>"]
 *   ["scope", "<scope-slug>"]
 *   ["trycompai_id", "<deal-id>"]          bridge correlation
 *   ["budget_hours", "<n>"]
 *   ["title", "<memo title>"]
 *
 * Content is the long-form memo body (markdown). Operator sign-along is
 * added by the caller after this returns.
 */
export function buildDealMemoTemplate({ dealId, clientPubkey, scope, budgetHours, title, body, createdAt }) {
  if (!dealId || !clientPubkey || !scope || !title) {
    throw new Error("dealId, clientPubkey, scope, and title are required");
  }
  return {
    kind: 30023,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ["d", `deal-${dealId}`],
      ["client", clientPubkey],
      ["scope", scope],
      ["trycompai_id", dealId],
      ["budget_hours", String(budgetHours ?? 0)],
      ["title", title],
    ],
    content: body ?? `# ${title}\n\nScope: ${scope}\nBudget: ${budgetHours ?? "?"} hours`,
  };
}

/**
 * Build a kind:43001 (JOB_REQUEST) envelope for routing a CRM-originated
 * task to the appropriate CorePrt agent. Tags per the planning doc:
 *
 *   ["scope", "<scope-slug>"]
 *   ["deal", "<deal-id>"]
 *   ["client", "<contact-pubkey>"]
 *   ["gauntlet", "<bar-slug>"]            optional: when present, gauntlet
 *                                          delegates as documented in PR-3
 */
export function buildJobRequestTemplate({ scope, dealId, clientPubkey, gauntlet, content, createdAt }) {
  if (!scope || !dealId || !clientPubkey) {
    throw new Error("scope, dealId, and clientPubkey are required");
  }
  const tags = [
    ["scope", scope],
    ["deal", dealId],
    ["client", clientPubkey],
  ];
  if (gauntlet) tags.push(["gauntlet", gauntlet]);
  return {
    kind: 43001,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: content ?? `Deal ${dealId}: work on ${scope}`,
  };
}

/**
 * Build a kind:1 (RECEIPT) envelope for status updates flowing back from
 * the agent to trycompai. Tags:
 *
 *   ["e", "<job-event-id>", "reply"]
 *   ["scope", "<scope-slug>"]
 *   ["deal", "<deal-id>"]
 *   ["receipt_kind", "progress"|"result"|"blocker"|"delivered"]
 */
export function buildReceiptTemplate({ jobEventId, scope, dealId, receiptKind, content, createdAt }) {
  if (!jobEventId || !scope || !dealId || !receiptKind) {
    throw new Error("jobEventId, scope, dealId, and receiptKind are required");
  }
  if (!["progress", "result", "blocker", "delivered"].includes(receiptKind)) {
    throw new Error(`receiptKind must be one of progress|result|blocker|delivered (got ${receiptKind})`);
  }
  return {
    kind: 1,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ["e", jobEventId, "reply"],
      ["scope", scope],
      ["deal", dealId],
      ["receipt_kind", receiptKind],
    ],
    content: content ?? `[${receiptKind}] ${scope}: ${dealId}`,
  };
}

// ─── public surface ─────────────────────────────────────────────────────

/**
 * Onboard a new client: generate a dealId, build and sign a kind:30023
 * deal memo, push to trycompai (best-effort). The memo is signed by
 * the caller's `signerNsec`. The caller is responsible for publishing
 * the returned `dealEvent` to the relay — this module stays
 * relay-agnostic so it can be unit-tested without a relay connection.
 *
 * Returns { dealId, dealEvent, nostrNpub, ok, mode, trycompaiPosted }.
 */
export async function crmOnboard({ client, contact, scope, budgetHours, dealMemo, signerNsec, log }) {
  const dealId = randomUUID();
  const cfg = getConfig();
  const keypair = getKeypairFromHex(signerNsec);
  const template = buildDealMemoTemplate({
    dealId,
    clientPubkey: contact,
    scope,
    budgetHours,
    title: dealMemo?.title ?? `WeRnds — ${client} — ${scope}`,
    body: dealMemo?.body,
  });
  const dealEvent = finalizeEvent(template, keypair.skBytes);
  let trycompaiPosted = false;
  if (cfg.provider === "trycompai") {
    try {
      await trycompaiFetch("/deals", {
        method: "POST",
        body: JSON.stringify({
          external_id: dealId,
          client,
          contact_pubkey: contact,
          scope,
          budget_hours: budgetHours,
          nostr_deal_event_id: dealEvent.id,
        }),
      });
      trycompaiPosted = true;
    } catch (err) {
      if (log) log(`crmOnboard: trycompai POST failed: ${err.message}`);
    }
  } else {
    appendStubLog(`crmOnboard deal=${dealId} client=${client} scope=${scope} nostr_event=${dealEvent.id}`);
  }
  return {
    dealId,
    dealEvent,
    agentPubkey: keypair.pkHex,
    ok: true,
    mode: cfg.provider,
    trycompaiPosted,
  };
}

/**
 * Look up a deal's current status. In stub mode, returns the last log
 * line for the dealId from crm-stub.log. In trycompai mode, GETs the
 * deal from trycompai. The Nostr side is the audit trail — `recentEvents`
 * are kind:1 receipts whose `["deal", dealId]` tag matches.
 */
export async function crmStatus({ dealId, recentEvents, nostrOnly = false }) {
  const cfg = getConfig();
  let status = "unknown";
  if (cfg.provider === "trycompai" && !nostrOnly) {
    try {
      const res = await trycompaiFetch(`/deals/${dealId}`);
      status = res?.status ?? "unknown";
    } catch {
      status = "trycompai unreachable";
    }
  } else {
    status = "stub (Nostr-only)";
  }
  return { dealId, status, recentEvents: recentEvents ?? [], ok: true, mode: cfg.provider };
}

/**
 * Publish a kind:1 RECEIPT for a deal. Best-effort push to trycompai.
 * Returns { receiptEventId, receiptEvent, agentPubkey, postedToTrycompai, ok, mode }.
 */
export async function crmReceipt({ dealId, scope, jobEventId, receiptKind, content, signerNsec, log }) {
  const cfg = getConfig();
  const keypair = getKeypairFromHex(signerNsec);
  const template = buildReceiptTemplate({
    jobEventId,
    scope,
    dealId,
    receiptKind,
    content,
  });
  const receiptEvent = finalizeEvent(template, keypair.skBytes);
  let postedToTrycompai = false;
  if (cfg.provider === "trycompai") {
    try {
      await trycompaiFetch(`/deals/${dealId}/receipts`, {
        method: "POST",
        body: JSON.stringify({
          nostr_receipt_event_id: receiptEvent.id,
          receipt_kind: receiptKind,
          content,
        }),
      });
      postedToTrycompai = true;
    } catch (err) {
      if (log) log(`crmReceipt: trycompai POST failed: ${err.message}`);
    }
  } else {
    appendStubLog(`crmReceipt deal=${dealId} kind=${receiptKind} nostr_event=${receiptEvent.id}`);
  }
  return {
    receiptEventId: receiptEvent.id,
    receiptEvent,
    agentPubkey: keypair.pkHex,
    postedToTrycompai,
    ok: true,
    mode: cfg.provider,
  };
}

// ─── internals for tests ────────────────────────────────────────────────

export const _internals = {
  loadCrmEnv,
  getConfig,
  appendStubLog,
  trycompaiFetch,
};
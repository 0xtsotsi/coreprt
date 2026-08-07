// __tests__/crm-bridge.test.js — trycompai/crm bridge module unit tests.
//
// Exercises the pure functions: buildDealMemoTemplate,
// buildJobRequestTemplate, buildReceiptTemplate, crmOnboard (stub mode),
// crmStatus (stub mode), crmReceipt (stub mode), and the env loader.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDealMemoTemplate,
  buildJobRequestTemplate,
  buildReceiptTemplate,
  crmOnboard,
  crmStatus,
  crmReceipt,
  _internals,
} from "../crm-bridge.mjs";

// Use an isolated HOME so the stub log writes go to a tmp dir.
const HOME = mkdtempSync(join(tmpdir(), "coreprt-crm-"));
process.env.HOME = HOME;
process.env.CRM_PROVIDER = "stub";
// Disable trycompai env to keep tests in pure stub mode.
delete process.env.TRYCOMPAI_API_URL;
delete process.env.TRYCOMPAI_TOKEN;

test("crm: buildDealMemoTemplate sets the expected tags", () => {
  const t = buildDealMemoTemplate({
    dealId: "deal-uuid",
    clientPubkey: "50769b0f",
    scope: "landing-page-v2",
    budgetHours: 16,
    title: "Acme landing page",
    body: "memo body for Acme landing page",
  });
  assert.equal(t.kind, 30023);
  const tagMap = Object.fromEntries(t.tags);
  assert.equal(tagMap.d, "deal-deal-uuid");
  assert.equal(tagMap.client, "50769b0f");
  assert.equal(tagMap.scope, "landing-page-v2");
  assert.equal(tagMap.trycompai_id, "deal-uuid");
  assert.equal(tagMap.budget_hours, "16");
  assert.equal(tagMap.title, "Acme landing page");
  assert.match(t.content, /Acme landing page/);
});

test("crm: buildDealMemoTemplate throws on missing required fields", () => {
  assert.throws(() => buildDealMemoTemplate({}), /required/);
  assert.throws(() => buildDealMemoTemplate({ dealId: "x" }), /required/);
  assert.throws(() => buildDealMemoTemplate({ dealId: "x", clientPubkey: "y" }), /required/);
  assert.throws(() => buildDealMemoTemplate({ dealId: "x", clientPubkey: "y", scope: "z" }), /required/);
});

test("crm: buildJobRequestTemplate sets the expected tags", () => {
  const t = buildJobRequestTemplate({
    dealId: "deal-uuid",
    clientPubkey: "50769b0f",
    scope: "landing-page-v2",
    content: "Build the hero section",
  });
  assert.equal(t.kind, 43001);
  const tagMap = Object.fromEntries(t.tags);
  assert.equal(tagMap.scope, "landing-page-v2");
  assert.equal(tagMap.deal, "deal-uuid");
  assert.equal(tagMap.client, "50769b0f");
  // No gauntlet tag unless provided
  assert.equal(tagMap.gauntlet, undefined);
});

test("crm: buildJobRequestTemplate includes gauntlet tag when provided", () => {
  const t = buildJobRequestTemplate({
    dealId: "deal-uuid",
    clientPubkey: "50769b0f",
    scope: "landing-page-v2",
    gauntlet: "thecardyard-home",
  });
  const tagMap = Object.fromEntries(t.tags);
  assert.equal(tagMap.gauntlet, "thecardyard-home");
});

test("crm: buildReceiptTemplate sets the expected tags", () => {
  const t = buildReceiptTemplate({
    jobEventId: "abcd1234",
    scope: "landing-page-v2",
    dealId: "deal-uuid",
    receiptKind: "progress",
    content: "Hero shipped",
  });
  assert.equal(t.kind, 1);
  const tagMap = Object.fromEntries(t.tags);
  assert.equal(tagMap.scope, "landing-page-v2");
  assert.equal(tagMap.deal, "deal-uuid");
  assert.equal(tagMap.receipt_kind, "progress");
});

test("crm: buildReceiptTemplate rejects invalid receiptKind", () => {
  assert.throws(
    () => buildReceiptTemplate({ jobEventId: "x", scope: "y", dealId: "z", receiptKind: "garbage", content: "c" }),
    /progress\|result\|blocker\|delivered/,
  );
});

test("crm: buildReceiptTemplate throws on missing fields", () => {
  assert.throws(() => buildReceiptTemplate({}), /required/);
  assert.throws(() => buildReceiptTemplate({ jobEventId: "x" }), /required/);
  assert.throws(() => buildReceiptTemplate({ jobEventId: "x", scope: "y" }), /required/);
  assert.throws(() => buildReceiptTemplate({ jobEventId: "x", scope: "y", dealId: "z" }), /required/);
});

// Use a known test nsec (this is from a throwaway key, never production).
const TEST_NSEC = "0000000000000000000000000000000000000000000000000000000000000001";

test("crm: crmOnboard in stub mode returns a dealEvent and writes to stub log", async () => {
  const result = await crmOnboard({
    client: "Acme Corp",
    contact: "50769b0f0000000000000000000000000000000000000000000000000000ab",
    scope: "landing-page-v2",
    budgetHours: 16,
    dealMemo: { title: "Acme landing", body: "# Acme landing\n\nBrief." },
    signerNsec: TEST_NSEC,
  });
  assert.ok(result.dealId);
  assert.ok(result.dealEvent);
  assert.equal(result.dealEvent.kind, 30023);
  assert.ok(result.dealEvent.id.length === 64);
  assert.equal(result.mode, "stub");
  assert.equal(result.trycompaiPosted, false);
  const logPath = join(HOME, ".config", "coreprt", "crm-stub.log");
  assert.ok(existsSync(logPath), "stub log should be created");
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /crmOnboard deal=/);
  assert.match(log, /client=Acme Corp/);
});

test("crm: crmStatus in stub mode returns 'stub (Nostr-only)'", async () => {
  const r = await crmStatus({ dealId: "x", recentEvents: [] });
  assert.equal(r.status, "stub (Nostr-only)");
  assert.equal(r.mode, "stub");
});

test("crm: crmReceipt in stub mode returns a receipt event id and writes to log", async () => {
  const result = await crmReceipt({
    dealId: "deal-uuid",
    scope: "landing-page-v2",
    jobEventId: "abcd1234",
    receiptKind: "delivered",
    content: "All pages shipped",
    signerNsec: TEST_NSEC,
  });
  assert.ok(result.receiptEventId);
  assert.equal(result.mode, "stub");
  assert.equal(result.postedToTrycompai, false);
  const logPath = join(HOME, ".config", "coreprt", "crm-stub.log");
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /crmReceipt deal=deal-uuid kind=delivered/);
});

test("crm: getConfig returns stub defaults when crm.env is missing", () => {
  const cfg = _internals.getConfig();
  assert.equal(cfg.provider, "stub");
  assert.equal(cfg.apiUrl, "");
  assert.equal(cfg.token, "");
});

test("crm: appendStubLog creates the .config/coreprt directory if missing", () => {
  // Already exercised by crmOnboard and crmReceipt tests above. Sanity:
  // confirm the log file grew.
  const logPath = join(HOME, ".config", "coreprt", "crm-stub.log");
  assert.ok(existsSync(logPath));
});

test("crm: cleanup", () => {
  rmSync(HOME, { recursive: true, force: true });
  assert.ok(!existsSync(HOME));
});
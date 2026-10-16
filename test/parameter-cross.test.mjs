import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  agentContext,
  applyContextLines,
  bulkExtras,
  classifyBulkRow,
  closedToIup,
  crossAppliesToProducts,
  effectiveForValue,
  emptyContext,
  evaluateDependencies,
  iupZeroWarning,
  renderDependencies,
  setContextValue,
  translateCompanyCode,
} from "../dist/services/cross-logic.js";

// ── fixtures ────────────────────────────────────────────────────────

let nextId = 1;
const cross = (over = {}) => ({
  ParameterValueCrossedId: nextId++,
  ParameterId: 4,
  OriginalValue: "3",
  InsuranceCompanyId: 100,
  InsuranceCompanyName: "AK Sigorta",
  ProductId: -1,
  ProductName: "Tanımsız",
  AgentType: 0,
  CrossName: "x",
  CrossValue: "005",
  Dependent: false,
  IsConverged: false,
  ...over,
});

const dep = (keyName, op, value, over = {}) => ({
  Id: nextId++,
  ParameterValueCrossedId: 1,
  ParameterId: 4,
  ParameterValue: "3",
  InsuranceCompanyId: 100,
  ProductId: -1,
  CrossValue: "005",
  DependentKeyId: { "Acente ID": 113, "Parent ID": 5241, "Araç Kullanım Şekli": 38 }[keyName] ?? 999,
  DependentKeyName: keyName,
  DependentKeyValue: value,
  DependencyType: op,
  DependencyGroupNo: 0,
  DependencyGroupConnectionTypeToOtherGroup: null,
  DependencyConnectionTypeToOtherKey: null,
  DependencyExecutionLevelForOtherKey: null,
  ...over,
});

const ctxOf = (pairs) => {
  const ctx = emptyContext();
  for (const [k, v] of pairs) setContextValue(ctx, k, v);
  return ctx;
};

const evaluated = (c, deps, ctx) => ({ cross: c, deps, result: evaluateDependencies(deps, ctx) });

const agents = new Map(
  [
    { Id: 11588, ParentId: 0, AgentName: "VDF", Status: true },
    { Id: 11723, ParentId: 0, AgentName: "VDF PREP", Status: false },
    { Id: 11739, ParentId: 700, AgentName: "Sencard", Status: true },
    { Id: 20001, ParentId: 11739, AgentName: "Sencard Alt", Status: true },
  ].map((a) => [a.Id, a])
);

// ── dependency evaluation ───────────────────────────────────────────

test("rows OR inside a group, groups AND (Faruk's VDF example)", () => {
  const deps = [
    dep("Acente ID", "=", "11588", { DependencyGroupNo: 0, DependencyConnectionTypeToOtherKey: "||", DependencyGroupConnectionTypeToOtherGroup: "&&" }),
    dep("Acente ID", "=", "11723", { DependencyGroupNo: 0, DependencyGroupConnectionTypeToOtherGroup: "&&" }),
    dep("Araç Kullanım Şekli", "=", "01", { DependencyGroupNo: 1, DependencyConnectionTypeToOtherKey: "||" }),
    dep("Araç Kullanım Şekli", "=", "06", { DependencyGroupNo: 1 }),
  ];
  assert.equal(evaluateDependencies(deps, ctxOf([["Acente ID", "11723"], ["Araç Kullanım Şekli", "06"]])).verdict, "pass");
  assert.equal(evaluateDependencies(deps, ctxOf([["Acente ID", "11739"], ["Araç Kullanım Şekli", "06"]])).verdict, "fail");
  assert.equal(evaluateDependencies(deps, ctxOf([["Acente ID", "11588"]])).verdict, "unknown");
  assert.equal(
    renderDependencies(deps, agents),
    "(grup 0: Acente ID = 11588 (VDF) VEYA 11723 (VDF PREP – pasif)) VE (grup 1: Araç Kullanım Şekli = 01 VEYA 06)"
  );
});

test("group connector || makes either group sufficient", () => {
  const deps = [
    dep("Acente ID", "=", "11588", { DependencyGroupNo: 0, DependencyGroupConnectionTypeToOtherGroup: "||" }),
    dep("Araç Kullanım Şekli", "=", "07", { DependencyGroupNo: 1 }),
  ];
  assert.equal(evaluateDependencies(deps, ctxOf([["Acente ID", "1"], ["Araç Kullanım Şekli", "07"]])).verdict, "pass");
});

test("key Id in the context matches rows by DependentKeyId", () => {
  const deps = [dep("Araç Kullanım Şekli", "=", "01")];
  assert.equal(evaluateDependencies(deps, ctxOf([["38", "01"]])).verdict, "pass");
});

test("operators: >, <, [==], [!=]", () => {
  const ctx = ctxOf([["Bedel", "150"], ["Kod", "ABC-01"]]);
  assert.equal(evaluateDependencies([dep("Bedel", ">", "100")], ctx).verdict, "pass");
  assert.equal(evaluateDependencies([dep("Bedel", "<", "100")], ctx).verdict, "fail");
  assert.equal(evaluateDependencies([dep("Kod", "[==]", "01")], ctx).verdict, "pass");
  assert.equal(evaluateDependencies([dep("Kod", "[!=]", "01")], ctx).verdict, "fail");
});

test("Acente ID = 0 means all agents", () => {
  assert.equal(evaluateDependencies([dep("Acente ID", "=", "0")], ctxOf([["Acente ID", "11739"]])).verdict, "pass");
});

test("default context is a generic IUP agent under 700", () => {
  const { ctx, notes } = agentContext(agents, undefined);
  assert.ok(ctx.genericIupAgent);
  assert.match(notes[0], /700/);
  assert.equal(evaluateDependencies([dep("Parent ID", "=", "700")], ctx).verdict, "pass");
  assert.equal(evaluateDependencies([dep("Parent ID", "!=", "700")], ctx).verdict, "fail");
  assert.equal(evaluateDependencies([dep("Acente ID", "=", "11588")], ctx).verdict, "fail");
  assert.equal(evaluateDependencies([dep("Acente ID", "!=", "11588")], ctx).verdict, "pass");
});

test("agent context fills Acente ID and direct Parent ID, with the full chain", () => {
  const { ctx, chain, notes } = agentContext(agents, 20001);
  assert.equal(evaluateDependencies([dep("Parent ID", "=", "11739")], ctx).verdict, "pass");
  assert.deepEqual(chain, ["11739 Sencard", "700 InsurUp Parent"]);
  assert.ok(notes.some((n) => /doğrudan üstü 11739/.test(n)));
});

test("unparseable context lines are reported", () => {
  const ctx = emptyContext();
  assert.deepEqual(applyContextLines(ctx, ["Araç Kullanım Şekli=01", "bozuk"]), ["bozuk"]);
});

// ── IUP rules ───────────────────────────────────────────────────────

test("Parent ID ≠ 700 renders as closed to IUP", () => {
  const deps = [dep("Parent ID", "!=", "700")];
  assert.ok(closedToIup(deps));
  assert.match(renderDependencies(deps), /IUP'a kapalı/);
});

test("0 warning only when IUP agents can reach the cross", () => {
  const zero = cross({ CrossValue: "0" });
  assert.ok(iupZeroWarning(zero, []), "unconditional 0 is open to IUP");
  assert.equal(iupZeroWarning(zero, [dep("Parent ID", "!=", "700")]), null);
  assert.equal(iupZeroWarning(zero, [dep("Parent ID", "=", "11588")]), null);
  assert.ok(iupZeroWarning(zero, [dep("Araç Kullanım Şekli", "=", "07")]), "vehicle-only condition is reachable");
  assert.equal(iupZeroWarning(cross({ CrossValue: "005" }), []), null);
});

test("product -1 applies to every product", () => {
  assert.ok(crossAppliesToProducts(cross({ ProductId: -1 }), new Set([3177])));
  assert.ok(crossAppliesToProducts(cross({ ProductId: 3177 }), new Set([3177])));
  assert.ok(!crossAppliesToProducts(cross({ ProductId: 3236 }), new Set([3177])));
  assert.ok(crossAppliesToProducts(cross({ ProductId: 3236 }), null));
});

// ── effective value & bulk check ────────────────────────────────────

test("product-specific 0 overrides a generic value", () => {
  const eff = effectiveForValue("3", [
    evaluated(cross({ ProductId: -1, CrossValue: "005" }), [], ctxOf([])),
    evaluated(
      cross({ ProductId: 2930, CrossValue: "0", Dependent: true }),
      [dep("Araç Kullanım Şekli", "=", "07")],
      ctxOf([["Araç Kullanım Şekli", "07"]])
    ),
  ]);
  assert.equal(eff.status, "DESTEKLENMIYOR");
  assert.equal(eff.effective.cross.CrossValue, "0");
});

function valueSet(entries) {
  return {
    byValue: new Map(entries),
    valueText: new Map(entries.map(([v]) => [v, `değer ${v}`])),
  };
}

test("bulk: OK, overridden by 0, eliminated, missing, undecided", () => {
  const iup = agentContext(agents, undefined).ctx;
  const set = valueSet([
    ["1", [evaluated(cross({ CrossValue: "001" }), [], iup)]],
    [
      "5",
      [
        evaluated(cross({ CrossValue: "005" }), [], iup),
        evaluated(cross({ ProductId: 2930, CrossValue: "0", Dependent: true }), [dep("Parent ID", "=", "700")], iup),
      ],
    ],
    ["9", [evaluated(cross({ CrossValue: "009", Dependent: true }), [dep("Parent ID", "=", "11588")], iup)]],
    ["7", [evaluated(cross({ CrossValue: "007", Dependent: true }), [dep("Araç Kullanım Şekli", "=", "07")], iup)]],
  ]);
  assert.equal(classifyBulkRow("001", set).result, "OK");
  const overridden = classifyBulkRow("005", set);
  assert.equal(overridden.result, "EKSIK");
  assert.match(overridden.detail, /0 \(desteklenmiyor\)/);
  const eliminated = classifyBulkRow("009", set);
  assert.equal(eliminated.result, "EKSIK");
  assert.match(eliminated.detail, /elendi/);
  assert.equal(classifyBulkRow("123", set).result, "EKSIK");
  assert.equal(classifyBulkRow("007", set).result, "BELIRSIZ");
});

test("bulk extras: Faruk's ANK 5000 example is FAZLA_ACIK", () => {
  // Ak's table lists only ANK 1.000 (001) for Ekonomik Kasko / Kamyon, but
  // IGW's ANK 5.000 (005) cross is 'Ürün Tanımsız' and unconditional.
  const ctx = ctxOf([["Araç Kullanım Şekli", "07"]]);
  const set = valueSet([
    ["1", [evaluated(cross({ CrossValue: "001", ProductId: 2930, Dependent: true }), [dep("Araç Kullanım Şekli", "=", "07")], ctx)]],
    ["5", [evaluated(cross({ CrossValue: "005" }), [], ctx)]],
    ["0", [evaluated(cross({ CrossValue: "0" }), [], ctx)]],
    ["6", [evaluated(cross({ CrossValue: "006", ProductId: 2930, Dependent: true }), [dep("Araç Kullanım Şekli", "=", "07")], ctx)]],
  ]);
  const extras = bulkExtras(new Set(["001"]), set);
  assert.deepEqual(
    extras.map((x) => [x.cross.CrossValue, x.result]).sort(),
    [["005", "FAZLA_ACIK"], ["006", "FAZLA"]]
  );
});

test("company codes translate through crosses, zero crosses excluded", () => {
  const byValue = new Map([
    ["01", [cross({ CrossValue: "001" })]],
    ["06", [cross({ CrossValue: "0" })]],
  ]);
  assert.deepEqual(translateCompanyCode("001", byValue), ["01"]);
  assert.deepEqual(translateCompanyCode("0", byValue), []);
  assert.deepEqual(translateCompanyCode("999", byValue), []);
});

// ── opt-in: real panel end-to-end via the MCP stdio server ─────────
//
// Runs only with IGW_PANEL_E2E=1. Credentials come from the environment
// (IGW_PANEL_USERNAME / IGW_PANEL_PASSWORD) or from a KEY=VALUE file named by
// IGW_PANEL_ENV_FILE. Read-only.

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const e2eEnv = { ...loadEnvFile(process.env.IGW_PANEL_ENV_FILE), ...process.env };
const e2eEnabled =
  process.env.IGW_PANEL_E2E === "1" && Boolean(e2eEnv.IGW_PANEL_USERNAME && e2eEnv.IGW_PANEL_PASSWORD);

async function withServer(run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(rootDir, "dist", "index.js")],
    env: {
      ...e2eEnv,
      IGW_USERNAME: e2eEnv.IGW_USERNAME ?? "unused",
      IGW_PASSWORD: e2eEnv.IGW_PASSWORD ?? "unused",
      IGW_WEB_API_KEY: e2eEnv.IGW_WEB_API_KEY ?? "unused",
    },
    cwd: mkdtempSync(join(tmpdir(), "igw-e2e-")),
    stderr: "ignore",
  });
  const client = new Client({ name: "igw-e2e", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text?.slice(0, 300)}`);
    return JSON.parse(r.content[0].text);
  };
  try {
    await run(client, call);
  } finally {
    await client.close();
  }
}

test("panel e2e (IGW_PANEL_E2E=1)", { skip: !e2eEnabled && "set IGW_PANEL_E2E=1 with panel credentials" }, async () => {
  await withServer(async (client, call) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of [
      "igw_parameter_get",
      "igw_crosses_list",
      "igw_cross_dependencies",
      "igw_key_dependencies",
      "igw_agents_search",
      "igw_values_for_context",
      "igw_compare_products",
      "igw_value_trace",
      "igw_crosses_bulk_check",
    ]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    assert.match(client.getInstructions() ?? "", /ForAgent/);

    // Faruk's acceptance query: Key 17 → parameter 4, value 3, crosses with dependencies.
    const p4 = await call("igw_parameter_get", { parameterId: 4 });
    assert.ok(p4.keys.some((k) => k.startsWith("17 ")));
    const crosses = await call("igw_crosses_list", { parameterId: 4, parameterValue: "3", includeDependencies: true, pageSize: 100 });
    assert.ok(crosses.matched > 0);
    assert.ok(crosses.crosses.every((c) => typeof c.dependency === "string"));

    // Product -1 counts for a product given by name.
    const cmp = await call("igw_compare_products", {
      parameterId: 4,
      companyId: "7",
      products: ["Kasko"],
      valueText: "30.000-90.000-30.000",
      onlyDifferences: false,
    });
    assert.ok(cmp.values[0].products.every((p) => p.status !== "TANIM_YOK"));
  });
});

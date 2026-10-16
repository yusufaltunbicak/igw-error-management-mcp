import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Unit tests for the dependency rendering / evaluation helpers, plus an
 * opt-in end-to-end smoke test over the REAL GatewayProUI panel
 * (Faruk's acceptance query: "Key 17 (IMM Limiti) → Parametre 4, değer 3
 * → cross'ları dependency'leriyle getir").
 *
 * The panel test runs only when panel credentials are available — either
 * as env vars (IGW_PANEL_USERNAME / IGW_PANEL_PASSWORD) or in
 * ~/.config/igw-mcp/panel.env and ~/.config/igw-mcp/gateway.env. It is
 * read-only; it never writes to the panel.
 */

// ── unit: pure logic (no network) ───────────────────────────────────
const { renderCrossDependencies, evaluateCrossDependencies } = await import(
  "../dist/tools/parameter-cross.js"
);

test("renderCrossDependencies skips empty dependency lists", () => {
  assert.equal(renderCrossDependencies([]), "bağımlı kayıt yok (bağımsız tanım)");
});

test("renderCrossDependencies shows Parent ID ≠ 700 as IUP-closed", () => {
  const text = renderCrossDependencies([
    {
      Id: 1,
      ParameterValueCrossedId: 1,
      ParameterId: 4,
      ParameterValue: "3",
      InsuranceCompanyId: 2,
      ProductId: 1,
      CrossValue: "0",
      DependentKeyId: 5241,
      DependentKeyName: "Parent ID",
      DependentKeyValue: "700",
      DependencyType: "!=",
      DependencyGroupNo: 0,
      DependencyGroupConnectionTypeToOtherGroup: null,
      DependencyConnectionTypeToOtherKey: null,
      DependencyExecutionLevelForOtherKey: null,
    },
  ]);
  assert.match(text, /IUP'a kapalı/);
});

test("evaluateCrossDependencies ORs rows inside a group and ANDs groups", () => {
  const mk = (groupNo, keyName, value, rowConn, groupConn) => ({
    Id: groupNo * 10 + value.length,
    ParameterValueCrossedId: 1,
    ParameterId: 4,
    ParameterValue: "3",
    InsuranceCompanyId: 2,
    ProductId: 1,
    CrossValue: "x",
    DependentKeyId: 1,
    DependentKeyName: keyName,
    DependentKeyValue: value,
    DependencyType: "=",
    DependencyGroupNo: groupNo,
    DependencyGroupConnectionTypeToOtherGroup: groupConn,
    DependencyConnectionTypeToOtherKey: rowConn,
    DependencyExecutionLevelForOtherKey: null,
  });

  // group 0: Acente ID = 11588 || 11723 ; group 1: Araç Kullanım Şekli = 01 || 06
  const deps = [
    mk(0, "Acente ID", "11588", "||", "&&"),
    mk(0, "Acente ID", "11723", null, "&&"),
    mk(1, "Araç Kullanım Şekli", "01", "||", "&&"),
    mk(1, "Araç Kullanım Şekli", "06", null, "&&"),
  ];

  const pass = evaluateCrossDependencies(deps, {
    map: new Map([
      ["Acente ID", "11588"],
      ["Araç Kullanım Şekli", "06"],
    ]),
  });
  assert.equal(pass.verdict, "pass");

  const fail = evaluateCrossDependencies(deps, {
    map: new Map([
      ["Acente ID", "700"],
      ["Araç Kullanım Şekli", "06"],
    ]),
  });
  assert.equal(fail.verdict, "fail");

  // context missing a condition → unknown, not fail
  const unknown = evaluateCrossDependencies(deps, {
    map: new Map([["Acente ID", "11588"]]),
  });
  assert.equal(unknown.verdict, "unknown");
});

test("evaluateCrossDependencies treats Acente ID = 0 as all-agents", () => {
  const deps = [
    {
      Id: 1,
      ParameterValueCrossedId: 1,
      ParameterId: 4,
      ParameterValue: "3",
      InsuranceCompanyId: 2,
      ProductId: 1,
      CrossValue: "x",
      DependentKeyId: 113,
      DependentKeyName: "Acente ID",
      DependentKeyValue: "0",
      DependencyType: "=",
      DependencyGroupNo: 0,
      DependencyGroupConnectionTypeToOtherGroup: null,
      DependencyConnectionTypeToOtherKey: null,
      DependencyExecutionLevelForOtherKey: null,
    },
  ];
  const v = evaluateCrossDependencies(deps, { map: new Map([["Acente ID", "11739"]]) });
  assert.equal(v.verdict, "pass");
});

// ── opt-in: real panel end-to-end via the MCP stdio server ─────────

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = join(rootDir, "dist", "index.js");

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = {
  ...process.env,
  ...loadEnvFile(join(process.env.HOME ?? "", ".config/igw-mcp/gateway.env")),
  ...loadEnvFile(join(process.env.HOME ?? "", ".config/igw-mcp/panel.env")),
};

const panelReady = Boolean(env.IGW_PANEL_USERNAME && env.IGW_PANEL_PASSWORD);

async function withServer(run) {
  if (!panelReady) return;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { ...env, IGW_PANEL_BASE_URL: env.IGW_PANEL_BASE_URL ?? "https://panel.insurapps.net" },
    cwd: mkdtempSync(join(tmpdir(), "igw-e2e-")),
  });
  const client = new Client({ name: "igw-e2e", version: "1.0.0" });
  await client.connect(transport);
  const tk = (name, args) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  try {
    await run(client, tk);
  } finally {
    await client.close();
  }
}

test("panel e2e: Key 17 → Parametre 4 → değer 3 cross'ları (Faruk testi)", async (t) => {
  if (!panelReady) {
    t.skip("IGW panel credentials not available");
    return;
  }
  await withServer(async (client, tk) => {
    const tools = await client.listTools();
    const names = tools.tools.map((x) => x.name);
    for (const expected of [
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
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    // parameter_get parametre 4
    const p4 = await tk("igw_parameter_get", { parameterId: 4 });
    assert.ok(!p4.isError, "igw_parameter_get failed");
    const p4body = JSON.parse(p4.content[0].text);
    assert.ok(p4body.totalValues > 0, "parametre 4 değerleri boş dönmemeli");
    const value3 = p4body.values.find((v) => v.valueId === "3");
    assert.ok(value3, "parametre 4'te değeri 3 olan kayıt yok");
    assert.ok(value3.crossed, "değer 3'te cross tanımlı olmalı");

    // Faruk'un sorgusu: değer 3 cross'ları
    const cr = await client.callTool({
      name: "igw_crosses_list",
      arguments: { parameterId: 4, parameterValue: "3", includeDependencies: true },
    }, undefined, { timeout: 900000 });
    assert.ok(!cr.isError, "igw_crosses_list failed");
    const crBody = JSON.parse(cr.content[0].text);
    assert.ok(crBody.matched > 0, "değer 3 için cross dönmeli (54 bekleniyor)");

    // cross dependency 35065 (değer 3, ilk cross)
    const first = crBody.crosses[0];
    const cd = await client.callTool({
      name: "igw_cross_dependencies",
      arguments: { crossId: first.crossId },
    }, undefined, { timeout: 900000 });
    assert.ok(!cd.isError, "igw_cross_dependencies failed");
    const cdBody = JSON.parse(cd.content[0].text);
    assert.ok("readable" in cdBody && "dependencies" in cdBody);

    // acente arama
    const ag = await client.callTool({
      name: "igw_agents_search",
      arguments: { query: "VDF" },
    }, undefined, { timeout: 900000 });
    assert.ok(!ag.isError, "igw_agents_search failed");

    // bağlam değerleri
    const vc = await client.callTool({
      name: "igw_values_for_context",
      arguments: { parameterId: 4, agentId: 11588 },
    }, undefined, { timeout: 900000 });
    assert.ok(!vc.isError, "igw_values_for_context failed");

    // ürün karşılaştırma
    const cmp = await client.callTool({
      name: "igw_compare_products",
      arguments: { parameterId: 4, companyId: "Eureko", products: ["Standart Kasko", "Markalı Kasko"] },
    }, undefined, { timeout: 900000 });
    assert.ok(!cmp.isError, "igw_compare_products failed");

    // değer izi: Key 17 IMM Limiti → gönderilen değer 3
    const trace = await client.callTool({
      name: "igw_value_trace",
      arguments: { key: 17, sentValue: "3", companyId: "Eureko" },
    }, undefined, { timeout: 900000 });
    assert.ok(!trace.isError, "igw_value_trace failed");
    const traceBody = JSON.parse(trace.content[0].text);
    assert.ok(traceBody.matched >= 0 && Array.isArray(traceBody.matches));

    // toplu kontrol
    const bulk = await client.callTool({
      name: "igw_crosses_bulk_check",
      arguments: {
        companyId: "Eureko",
        rows: [
          { statCode: 17, valueCode: "0", product: "Standart Kasko" },
          { statCode: 17, valueCode: "999999", product: "Standart Kasko" },
        ],
      },
    }, undefined, { timeout: 900000 });
    assert.ok(!bulk.isError, "igw_crosses_bulk_check failed");
    const bulkBody = JSON.parse(bulk.content[0].text);
    assert.ok("tsv" in bulkBody && Array.isArray(bulkBody.rows));
  });
});

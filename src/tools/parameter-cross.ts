import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PanelClient } from "../services/panel.js";
import { truncateResult, handleApiError } from "../services/api.js";
import { serializeFitting } from "./panel-lists.js";
import {
  PanelCross,
  PanelCrossDependency,
  PanelParameterValue,
} from "../types.js";

/**
 * Faruk's read-only Parameter → Value → Cross → Dependency tools.
 *
 * All of these build on the PanelClient's cached fetches over the
 * GatewayProUI panel: parameters, parameter values, crosses, cross
 * dependencies, key dependencies and agents. Nothing writes to the panel.
 *
 * Panel binding quirks the code must respect:
 * - /ParameterValueCrossed/GetParameterValueCrosses silently returns an
 *   empty list unless both ParameterId and ParameterValue bind, so the
 *   service always sends them, and callers walk values of the parameter.
 * - Ürün Id -1 (Tanımsız) means the cross applies to all of the
 *   company's products.
 * - CrossValue "0" means "this value does not work for this
 *   company/product/agent context" — the tools report it as
 *   "desteklenmiyor", not as a real value.
 * - Parent ID != 700 means the cross is closed to IUP (InsurUp Parent).
 */

type Row = Record<string, unknown>;

const tr = (v: unknown): string =>
  String(v ?? "").toLocaleLowerCase("tr-TR");

const AGENT_TYPE_NAMES: Record<number, string> = {
  0: "Tanımsız",
  1: "Acente",
  2: "Broker",
  3: "Banka",
  4: "Sigorta Şirketi",
};

const PRODUCT_ALL = -1;

const OP_TEXT: Record<string, string> = {
  "=": "=",
  "!=": "≠",
  ">": ">",
  "<": "<",
  "[==]": "barındırır",
  "[!=]": "barındırmaz",
};

/** Keys whose condition can be auto-filled from the agent list. */
const KEY_AGENT_ID = "Acente ID";
const KEY_PARENT_ID = "Parent ID";
const IUP_PARENT = "700";

// ── Shared fetch helpers ────────────────────────────────────────────

const companyMatches = (
  c: Pick<PanelCross, "InsuranceCompanyId" | "InsuranceCompanyName">,
  company: string
): boolean => {
  const s = String(company ?? "").trim();
  if (!s) return true;
  if (/^\d+$/.test(s)) return Number(c.InsuranceCompanyId) === Number(s);
  return tr(c.InsuranceCompanyName).includes(tr(s));
};

const productMatches = (
  c: Pick<PanelCross, "ProductId" | "ProductName">,
  product?: string
): boolean => {
  const s = String(product ?? "").trim();
  if (!s || s === "-1") return true;
  if (/^\d+$/.test(s))
    return Number(c.ProductId) === Number(s) || Number(c.ProductId) === PRODUCT_ALL;
  if (tr(s) === "tüm ürünler" || tr(s) === "tanımsız")
    return Number(c.ProductId) === PRODUCT_ALL;
  return tr(c.ProductName).includes(tr(s));
};

/** Resolve one parameter from the catalog: exact id (when digits) or name substring. */
async function resolveParameter(
  panel: PanelClient,
  paramOrName: string | number
): Promise<{ ParameterId: number; ParameterName: string } | null> {
  const params = await panel.getAllParameters();
  const s = String(paramOrName).trim();
  if (/^\d+$/.test(s)) {
    const byId = params.find((p) => Number(p.ParameterId) === Number(s));
    return byId ? { ParameterId: byId.ParameterId, ParameterName: byId.ParameterName } : null;
  }
  const byName = params.find((p) => tr(p.ParameterName).includes(tr(s)));
  return byName
    ? { ParameterId: byName.ParameterId, ParameterName: byName.ParameterName }
    : null;
}

/** All crosses of a parameter, fetching every parameter value in turn. */
async function getAllCrossesOfParameter(
  panel: PanelClient,
  parameterId: number,
  valueFilter?: (v: PanelParameterValue) => boolean
): Promise<{ rows: PanelCross[]; valuesScanned: number }> {
  const values = await panel.getParameterValues(parameterId);
  const selected = valueFilter ? values.filter(valueFilter) : values;
  const crosses: PanelCross[] = [];
  for (const v of selected) {
    const rows = await panel.getParameterCrosses(parameterId, v.Value);
    crosses.push(...rows);
  }
  return { rows: crosses, valuesScanned: selected.length };
}

// ── Dependency rendering & evaluation ───────────────────────────────

const depOpText = (op: string): string => OP_TEXT[op] ?? op;

/** One condition as a readable fragment, e.g. "Parent ID ≠ 700". */
function depFragment(
  dep: Pick<PanelCrossDependency, "DependentKeyId" | "DependentKeyName" | "DependencyType" | "DependentKeyValue">,
  agentNames?: Map<number, string>
): string {
  const value = dep.DependentKeyValue;
  const idPart = `${dep.DependentKeyName} (Key ${dep.DependentKeyId})`;
  // Mention well-known agent value semantics explicitly.
  if (dep.DependentKeyName === KEY_PARENT_ID && value === IUP_PARENT && dep.DependencyType === "!=") {
    return `Parent ID ≠ 700 → IUP'a kapalı`;
  }
  if (dep.DependentKeyName === KEY_AGENT_ID && value === "0") {
    return `Acente ID = 0 (tüm acenteler)`;
  }
  const name = agentNames?.get(Number(value));
  const suffix = name ? ` (${name})` : "";
  return `${idPart} ${depOpText(dep.DependencyType)} ${value}${suffix}`;
}

/**
 * Join dependency rows into a readable expression honouring
 * DependencyConnectionTypeToOtherKey (within the group) and
 * DependencyGroupConnectionTypeToOtherGroup (between groups):
 * "Acente ID = 11588 VEYA 11723, gruplar arasında VE".
 */
export function renderCrossDependencies(
  deps: PanelCrossDependency[],
  agentNames?: Map<number, string>
): string {
  if (!deps.length) return "bağımlı kayıt yok (bağımsız tanım)";
  const byGroup = new Map<string, PanelCrossDependency[]>();
  for (const d of deps) {
    const g = d.DependencyGroupNo == null ? "∅" : String(d.DependencyGroupNo);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(d);
  }

  const groupExprs: string[] = [];
  const groupJoins: string[] = [];
  let prevTop: PanelCrossDependency | null = null;

  const sortedGroups = [...byGroup.entries()].sort(
    (a, b) => (a[0] === "∅" ? 1 : b[0] === "∅" ? -1 : Number(a[0]) - Number(b[0]))
  );
  for (const [g, rows] of sortedGroups) {
    let expr = depFragment(rows[0], agentNames);
    for (let i = 1; i < rows.length; i++) {
      const conn =
        rows[i - 1].DependencyConnectionTypeToOtherKey === "||" ? "VEYA" : "VE";
      expr += ` ${conn} ${depFragment(rows[i], agentNames)}`;
    }
    groupExprs.push(g === "∅" ? expr : `grup ${g}: ${expr}`);
    if (prevTop) {
      const conn =
        prevTop.DependencyGroupConnectionTypeToOtherGroup === "||"
          ? "VEYA"
          : "VE";
      groupJoins.push(conn);
    }
    prevTop = rows[rows.length - 1];
  }

  let out = groupExprs[0];
  for (let i = 1; i < groupExprs.length; i++) out += ` ${groupJoins[i - 1]} ${groupExprs[i]}`;
  return out;
}

/** IUP-facing warning for a cross, when any dependency is Parent ID ≠ 700. */
function iupWarningFor(deps: PanelCrossDependency[]): string | null {
  const hasParentNot700 = deps.some(
    (d) =>
      d.DependentKeyName === KEY_PARENT_ID &&
      d.DependencyType === "!=" &&
      String(d.DependentKeyValue) === IUP_PARENT
  );
  return hasParentNot700 ? "Parent ID ≠ 700 → IUP'a kapalı" : null;
}

// ── Context evaluation (values_for_context core) ────────────────────

export interface EvaluationContext {
  /** key name → value, e.g. "Acente ID" → "11739", "Parent ID" → "700" */
  map: Map<string, string>;
}

export type RowVerdict = "pass" | "fail" | "unknown";

/**
 * Evaluate one dependency row against a context. "Acente ID = 0"
 * (tüm acenteler) always passes when any agent context exists.
 */
function evaluateRow(
  dep: PanelCrossDependency,
  ctx: EvaluationContext
): RowVerdict {
  const ctxValue = ctx.map.get(dep.DependentKeyName);
  if (ctxValue === undefined) return "unknown";
  // treat "=" and "!=" as exact string compare; other ops numeric-ish compare
  const lhs = String(ctxValue).trim();
  const rhs = String(dep.DependentKeyValue).trim();
  if (dep.DependentKeyName === KEY_AGENT_ID && rhs === "0") return "pass";
  switch (dep.DependencyType) {
    case "=":
      return lhs === rhs ? "pass" : "fail";
    case "!=":
      return lhs !== rhs ? "pass" : "fail";
    case ">":
      return Number(lhs) > Number(rhs) ? "pass" : "fail";
    case "<":
      return Number(lhs) < Number(rhs) ? "pass" : "fail";
    case "[==]":
      return lhs.includes(rhs) ? "pass" : "fail";
    case "[!=]":
      return lhs.includes(rhs) ? "fail" : "pass";
    default:
      return "unknown";
  }
}

export interface CrossVerdict {
  verdict: "pass" | "fail" | "unknown";
  /** Per-group verdicts; groups AND together. */
  groups: Array<{
    groupNo: string;
    verdict: RowVerdict | "andUnknown";
    rows: Array<{ dep: PanelCrossDependency; verdict: RowVerdict }>;
  }>;
}

/**
 * Evaluate a cross's dependency groups against a context. Groups AND
 * together; rows inside a group combine by their
 * DependencyConnectionTypeToOtherKey ("&&"/"||"), default &&.
 */
export function evaluateCrossDependencies(
  deps: PanelCrossDependency[],
  ctx: EvaluationContext
): CrossVerdict {
  const byGroup = new Map<string, PanelCrossDependency[]>();
  for (const d of deps) {
    const g = d.DependencyGroupNo == null ? "∅" : String(d.DependencyGroupNo);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(d);
  }
  const groups = [...byGroup.entries()]
    .sort(
      (a, b) =>
        (a[0] === "∅" ? 1 : 0) - (b[0] === "∅" ? 1 : 0) ||
        Number(a[0]) - Number(b[0])
    )
    .map(([groupNo, rows]) => {
      const evaluated = rows.map((dep) => ({
        dep,
        verdict: evaluateRow(dep, ctx),
      }));
      // combine within the group
      let acc: RowVerdict = evaluated[0].verdict;
      for (let i = 1; i < evaluated.length; i++) {
        const conn =
          evaluated[i - 1].dep.DependencyConnectionTypeToOtherKey === "||"
            ? "||"
            : "&&";
        const v = evaluated[i].verdict;
        if (conn === "||") {
          if (acc === "pass" || v === "pass") acc = "pass";
          else if (acc === "unknown" || v === "unknown") acc = "unknown";
          else acc = "fail";
        } else {
          if (acc === "fail" || v === "fail") acc = "fail";
          else if (acc === "unknown" || v === "unknown") acc = "unknown";
          else acc = "pass";
        }
      }
      return { groupNo, verdict: acc, rows: evaluated };
    });

  let verdict = groups[0]?.verdict ?? "pass";
  for (let i = 1; i < groups.length; i++) {
    const conn =
      groups[i - 1].rows[groups[i - 1].rows.length - 1]?.dep
        .DependencyGroupConnectionTypeToOtherGroup === "||"
        ? "||"
        : "&&";
    const v = groups[i].verdict;
    if (conn === "||") {
      if (verdict === "pass" || v === "pass") verdict = "pass";
      else if (verdict === "unknown" || v === "unknown") verdict = "unknown";
      else verdict = "fail";
    } else {
      if (verdict === "fail" || v === "fail") verdict = "fail";
      else if (verdict === "unknown" || v === "unknown") verdict = "unknown";
      else verdict = "pass";
    }
  }
  return { verdict, groups };
}

/** Shared agent lookup (cached by the panel client). Returns [id → name]. */
async function getAgentNames(panel: PanelClient): Promise<Map<number, string>> {
  const agents = (await panel.fetchAll<Row>("Agent/GetAgents")) as Array<Row>;
  return new Map(
    agents.map((a) => [Number(a.Id), String(a.AgentName ?? "")])
  );
}

/**
 * Build the evaluation context from the tool's inputs: agent + its parent
 * chain (via the agent list) and user-supplied "KeyName=Value" pairs.
 */
async function buildContext(
  panel: PanelClient,
  agentId?: number,
  extraContext?: string[]
): Promise<{ ctx: EvaluationContext; notes: string[] }> {
  const map = new Map<string, string>();
  const notes: string[] = [];
  if (agentId != null) {
    map.set(KEY_AGENT_ID, String(agentId));
    // resolve the parent chain from the agent list
    const agents = (await panel.fetchAll<Row>("Agent/GetAgents")) as Array<Row>;
    let current = agents.find((a) => Number(a.Id) === Number(agentId));
    if (!current) {
      notes.push(`${agentId} kodlu acente acente listesinde bulunamadı`);
    } else {
      let cursor = Number(current.ParentId);
      const seen = new Set<number>();
      if (Number.isFinite(cursor)) {
        map.set(KEY_PARENT_ID, String(cursor));
        const chainName = String(current.ParentAgentName ?? "");
        if (chainName) notes.push(`üst acente: ${cursor} (${chainName})`);
      }
      cursor = 0; // ancestors above the direct parent stay out of scope;
                  // users can supply grand-parent restrictions via context
      void seen;
    }
  }
  for (const pair of extraContext ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      notes.push(`bağlam satırı "Key=Değer" biçiminde olmalı: "${pair}" — yok sayıldı`);
      continue;
    }
    map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return { ctx: { map }, notes };
}

// ── Cross row summarising ───────────────────────────────────────────

function summarizeCross(c: PanelCross, agentNames?: Map<number, string>): Row {
  return {
    crossId: c.ParameterValueCrossedId,
    company: c.InsuranceCompanyName
      ? `${c.InsuranceCompanyId} ${c.InsuranceCompanyName}`
      : String(c.InsuranceCompanyId),
    product:
      c.ProductId === PRODUCT_ALL
        ? "TÜM ÜRÜNLER (-1)"
        : `${c.ProductId} ${c.ProductName ?? ""}`.trim(),
    agentType: AGENT_TYPE_NAMES[c.AgentType] ?? String(c.AgentType),
    crossName: c.CrossName,
    crossValue: c.CrossValue,
    dependent: c.Dependent,
    converged: c.IsConverged,
  };
}

/** Shared value/cross lookup, used by several tools. */
async function parameterValuesWithContext(
  panel: PanelClient,
  parameterId: number,
  refresh?: boolean
): Promise<{ parameterName: string; values: Array<PanelParameterValue & { crosses: PanelCross[] }> }> {
  const param = await panel.getAllParameters(refresh === true);
  const pp = param.find((p) => Number(p.ParameterId) === Number(parameterId));
  const values = await panel.getParameterValues(parameterId, refresh === true);
  // fetch crosses for the values concurrently (bounded so the panel is not hammered)
  const CONCURRENCY = 8;
  const results: Array<PanelParameterValue & { crosses: PanelCross[] }> = new Array(values.length);
  const queue = values.map((v, index) => ({ v, index }));
  const slots = Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const crosses = await panel.getParameterCrosses(
        parameterId,
        item.v.Value,
        refresh === true
      );
      results[item.index] = { ...item.v, crosses };
    }
  });
  await Promise.all(slots);
  const withCrosses = results as Array<PanelParameterValue & { crosses: PanelCross[] }>;
  return {
    parameterName: pp?.ParameterName ?? `Parameter ${parameterId}`,
    values: withCrosses,
  };
}

// ── Tool registration ───────────────────────────────────────────────

interface CompanyProductArgs {
  companyId?: string;
  productId?: string;
}

const companySchema = z
  .string()
  .optional()
  .describe("Sigorta şirketi: sayısal Id ya da ad alt kümesi (örn. 'Ak', '2')");

const productSchema = z
  .string()
  .optional()
  .describe("Ürün: sayısal GW ProductId ya da ad alt kümesi (örn. 'Standart Kasko')");

/**
 * Register the 9 read-only tools requested in the InsurGateway MCP spec
 * (Parametre, Cross, Dependency, Acente, bağlam, karşılaştırma, iz,
 * toplu kontrol). Everything read-only; caches ~10 minutes.
 */
export function registerParameterCrossTools(
  server: McpServer,
  panel: PanelClient
): void {
  // 1) igw_parameter_get — parameter + all of its values ──────────────
  server.tool(
    "igw_parameter_get",
    `Bir parametreyi ve TÜM değerlerini getirir (Parametre Yönetimi → Parametre Değerleri). parameterId ya da parametre adı (alt küme) ile arayın; ikisi birden verilirse önce Id denenir. Her değer için: Text (etiket), Value (OriginalValue), Crossed (cross tanımlı mı), IsAirSpecific ve Status. Tamamı salt-okunur.`,
    {
      parameterId: z.number().optional().describe("Doğrudan parametre Id (örn. 4)"),
      query: z.string().optional().describe("Parametre adında alt küme araması (örn. 'IMM Limitleri')"),
      refresh: z.boolean().optional().describe("10 dakikalık önbelleği geçip yeniden çek"),
    },
    async (args) => {
      try {
        if (args.parameterId == null && !args.query) {
          return {
            content: [
              { type: "text", text: "parameterId ya da query argümanlarından biri gerekli." },
            ],
            isError: true,
          };
        }
        let parameter: { ParameterId: number; ParameterName: string } | null = null;
        if (args.parameterId != null) {
          parameter = await resolveParameter(panel, args.parameterId);
        } else {
          const params = await panel.getAllParameters();
          const matches = params.filter((p) =>
            tr(p.ParameterName).includes(tr(args.query!))
          );
          if (matches.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `"${args.query}" ile eşleşen parametre bulunamadı.`,
                },
              ],
              isError: true,
            };
          }
          if (matches.length > 1) {
            return {
              content: [
                {
                  type: "text",
                  text: `"${args.query}" ${matches.length} parametreyle eşleşti, tek çağrıda netleştirin:\n${matches
                    .slice(0, 20)
                    .map((m) => `- ${m.ParameterId} ${m.ParameterName}`)
                    .join("\n")}`,
                },
              ],
              isError: true,
            };
          }
          const m = matches[0];
          parameter = { ParameterId: m.ParameterId, ParameterName: m.ParameterName };
        }

        const paramValue = parameter as { ParameterId: number; ParameterName: string };
        const values = await panel.getParameterValues(paramValue.ParameterId, args.refresh === true);
        const result = {
          parameter: paramValue,
          totalValues: values.length,
          activeValues: values.filter((v) => v.Status).length,
          values: values.map((v) => ({
            valueId: v.Value,
            text: v.Text,
            crossed: v.Crossed,
            isAirSpecific: v.IsAirSpecific,
            isActive: v.Status,
          })),
        };
        return { content: [{ type: "text", text: truncateResult(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 2) igw_crosses_list ────────────────────────────────────────────────
  server.tool(
    "igw_crosses_list",
    `Bir parametrenin (İsteğe bağlı: tek değerinin) ŞİRKET bazlı cross'larını listeler. Her satır: şirket, ürün (ProductId -1 = TÜM ÜRÜNLER), acente tipi, cross adı, cross değeri (şirkete giden asıl değer; "0" = bu bağlamda çalışmıyor), bağımlı mı, yakınsama mı. Argument: parameterId, tekbir değer için parameterValue (OriginalValue), şirket/ürün/acente tipi filtreleri; includeDependencies=true istenirse her cross'ın dependency'leri okunabilir ifadeyle döner. Kapsam salt-okunur.`,
    {
      parameterId: z.number().describe("Parametre Id (örn. 4 = IMM Limitleri)"),
      parameterValue: z.string().optional().describe("Tek parametre değeri (OriginalValue, ör. '3'); verilmezse değerin tümüne bakılır"),
      valueText: z.string().optional().describe("Değerin Text etiketinde alt küme filtre (örn. '30.000')"),
      companyId: companySchema,
      productId: productSchema,
      agentType: z.number().optional().describe("Acente tipi: 0 Tanımsız, 1 Acente, 2 Broker, 3 Banka, 4 Şirket"),
      crossValue: z.string().optional().describe("Cross değeri eşit filtre (örn. '005')"),
      crossName: z.string().optional().describe("Cross adında alt küme filtre"),
      includeDependencies: z.boolean().optional().describe("Her cross için dependency satırlarını da getir (okunabilir ifade)"),
      dependent: z.boolean().optional().describe("Yalnız bağımlı (true) veya bağımsız (false) cross'lar"),
      refresh: z.boolean().optional().describe("Önbelleği atla, yeniden çek"),
      page: z.number().optional().describe("Sayfa numarası (varsayılan 1)"),
      pageSize: z.number().optional().describe("Sayfa boyutu (varsayılan 50)"),
    },
    async (args) => {
      try {
        const valueFilter = (v: PanelParameterValue): boolean => {
          if (args.parameterValue != null && v.Value !== args.parameterValue) return false;
          if (args.valueText && !tr(v.Text).includes(tr(args.valueText))) return false;
          return true;
        };
        const { rows: all, valuesScanned } = await getAllCrossesOfParameter(
          panel,
          args.parameterId,
          valueFilter
        );
        const agentNames = await getAgentNames(panel);

        const filtered = all.filter((c) => {
          if (!companyMatches(c, args.companyId ?? "")) return false;
          if (!productMatches(c, args.productId)) return false;
          if (args.agentType != null && c.AgentType !== args.agentType) return false;
          if (args.crossValue != null && String(c.CrossValue) !== args.crossValue) return false;
          if (args.crossName && !tr(c.CrossName).includes(tr(args.crossName))) return false;
          if (args.dependent != null && c.Dependent !== args.dependent) return false;
          return true;
        });

        let depsMeta: Record<string, string> = {};
        let iupMeta: Record<string, string> = {};
        if (args.includeDependencies) {
          const selected = filtered.slice(0, 100);
          const CONCURRENCY = 8;
          const depTexts: Array<string | null> = new Array(selected.length);
          const depWarnings: Array<string | null> = new Array(selected.length);
          const depQueue = selected.map((c, index) => ({ c, index }));
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, selected.length) }, async () => {
              for (;;) {
                const item = depQueue.shift();
                if (!item) return;
                const deps = await panel.getCrossDependencies(
                  item.c.ParameterValueCrossedId,
                  args.refresh === true
                );
                depTexts[item.index] = renderCrossDependencies(deps, agentNames);
                depWarnings[item.index] = iupWarningFor(deps);
              }
            })
          );
          for (let i = 0; i < selected.length; i++) {
            depsMeta[String(selected[i].ParameterValueCrossedId)] = depTexts[i] ?? "";
            if (depWarnings[i]) iupMeta[String(selected[i].ParameterValueCrossedId)] = depWarnings[i]!;
          }
        }

        const projected = filtered.map((c) => {
          const row = summarizeCross(c, agentNames);
          if (args.includeDependencies) {
            row.dependency = depsMeta[String(c.ParameterValueCrossedId)] ?? "";
            const w = iupMeta[String(c.ParameterValueCrossedId)];
            if (w) row.iupWarning = w;
          }
          return row;
        });

        const page = args.page && args.page > 0 ? args.page : 1;
        const pageSize = args.pageSize && args.pageSize > 0 ? args.pageSize : 50;
        const start = (page - 1) * pageSize;
        const rows = projected.slice(start, start + pageSize);

        const text = serializeFitting(
          {
            parameterId: args.parameterId,
            valuesScanned,
            total: all.length,
            matched: filtered.length,
            page,
            pageSize,
            note:
              "Cross Değeri = şirkete giden asıl değer (logdaki <kod>…<deger>…). '0' bu bağlamda desteklenmeyen değer demektir. Ürün -1 (TÜM ÜRÜNLER) şirketin tüm ürünlerine uygulanır.",
          },
          "crosses",
          rows
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 3) igw_cross_dependencies ─────────────────────────────────────────
  server.tool(
    "igw_cross_dependencies",
    `Tek bir cross'ın (ParameterValueCrossedId) bağımlılık satırlarını getirir. Her satır: bağımlı key (Id+ad), bağlı key değeri, bağlılık tipi (=, !=, >, <, [==] barındırır, [!=] barındırmaz), grup numarası, gruplar arası ve grup içi bağlama tipi, diğer key'e bağlılık seviyesi. Çıktıda okunabilir ifade de vardır (ör. 'Acente ID (Key 113) = 11588 VEYA 11723'). Salt-okunur.`,
    {
      crossId: z.number().describe("ParameterValueCrossedId (igw_crosses_list çıktısında crossId)"),
      refresh: z.boolean().optional().describe("Önbelleği atla"),
    },
    async (args) => {
      try {
        const deps = await panel.getCrossDependencies(args.crossId, args.refresh === true);
        const agentNames = await getAgentNames(panel);
        const result = {
          crossId: args.crossId,
          total: deps.length,
          readable: renderCrossDependencies(deps, agentNames),
          iupWarning: iupWarningFor(deps),
          dependencies: deps.map((d) => ({
            id: d.Id,
            dependentKey: `${d.DependentKeyId} ${d.DependentKeyName}`,
            dependentKeyValue: d.DependentKeyValue,
            dependencyType: d.DependencyType,
            groupNo: d.DependencyGroupNo,
            groupConnectionToOtherGroup: d.DependencyGroupConnectionTypeToOtherGroup,
            rowConnectionToNextRow: d.DependencyConnectionTypeToOtherKey,
            executionLevelForOtherKey: d.DependencyExecutionLevelForOtherKey,
          })),
        };
        return { content: [{ type: "text", text: truncateResult(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 4) igw_key_dependencies ───────────────────────────────────────────
  server.tool(
    "igw_key_dependencies",
    `Bir key'in bağımlılıklarını getirir (Key ekranındaki mavi ikonun okudukları). keyId verin; từng tıkladığınız key ekranda mavi ikon varsa bu uçta bağımlılık satırları listelenir. Bağımlı key (Id+ad), böyle key değeri, bağlılık tipi, seviyeleri içerir. Salt-okunur.`,
    {
      keyId: z.number().describe("Key Id (örn. 36)"),
      refresh: z.boolean().optional().describe("Önbelleği atla"),
    },
    async (args) => {
      try {
        const deps = await panel.getKeyDependencies(args.keyId, args.refresh === true);
        const keys = await panel.getAllKeys();
        const byId = new Map(keys.map((k) => [k.Id, k.KeyName]));
        const agentNames = await getAgentNames(panel);
        const readable = deps
          .map(
            (d) =>
              `Key ${d.DependentKeyId} (${d.DependentKeyName ?? byId.get(d.DependentKeyId) ?? "?"}) ${
                OP_TEXT[d.DependencyType] ?? d.DependencyType
              } ${d.DependentKeyValue}`
          )
          .join("\n");
        const result = {
          keyId: args.keyId,
          keyName: keys.find((k) => k.Id === args.keyId)?.KeyName ?? null,
          total: deps.length,
          readable: readable || "bağımlılı yok",
          dependencies: deps.map((d) => ({
            id: d.Id,
            dependentKey: `${d.DependentKeyId} ${d.DependentKeyName ?? byId.get(d.DependentKeyId) ?? ""}`.trim(),
            dependentKeyValue: d.DependentKeyValue,
            dependencyType: d.DependencyType + (OP_TEXT[d.DependencyType] ? ` (${OP_TEXT[d.DependencyType]})` : ""),
            executionLevelForOtherKey: d.DependencyExecutionLevelForOtherKey,
            connectionToNextRow: d.DependencyConnectionTypeToOtherKey,
          })),
        };
        return { content: [{ type: "text", text: truncateResult(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 5) igw_agents_search — Acente listesi (üst zincir + tip + aktif) ──
  server.tool(
    "igw_agents_search",
    `IGW acente listesinde arama: kod (Id), ad, ÜST acente kodu/adı, AGENce tipi (Tanımsız/Reading Acente/Broker/Banka/...), aktif/pasif ve ÜST ZİNCİR (parent→grand-parent) çıktısı. Tüm filifler VE ile birleşir; eşleşme Türkçe büyük/küçük harf duyarsız alt küme. 700 = InsurUp Parent, -999 = SigortaPro Parent, -900 = BrokerPro Parent, 0 = All Agents.`,
    {
      query: z.string().optional().describe("Acente adında alt küme (örn. 'VDF' , 'Sencard')"),
      agentId: z.number().optional().describe("Eş aktif acente kodu (örn. 11588)"),
      parentId: z.number().optional().describe("Üst acente kodu"),
      parentName: z.string().optional().describe("Üst acente adında alt küme"),
      agentType: z.number().optional().describe("Acente tipi (0..4)"),
      isActive: z.boolean().optional().describe("true = aktifler, false = pasifler"),
      refresh: z.boolean().optional().describe("Önbelleği atla"),
      page: z.number().optional().describe("Sayfa (varsayılan 1)"),
      pageSize: z.number().optional().describe("Sayfa boyutu (varsayılan 50)"),
    },
    async (args) => {
      try {
        const agents = (await panel.fetchAll<Row>("Agent/GetAgents", args.refresh === true)) as Array<Row>;

        const filtered = agents.filter((a: Row) => {
          if (args.agentId != null && Number(a.Id) !== args.agentId) return false;
          if (args.query && !tr(a.AgentName).includes(tr(args.query))) return false;
          if (args.parentId != null && Number(a.ParentId) !== args.parentId) return false;
          if (args.parentName && !tr(a.ParentAgentName).includes(tr(args.parentName))) return false;
          if (args.agentType != null && Number(a.AgentType) !== args.agentType) return false;
          if (args.isActive != null && Boolean(a.Status) !== args.isActive) return false;
          return true;
        });

        const nameById = new Map(agents.map((a: Row) => [Number(a.Id), tr(a.AgentName)]));
        const chainOf = (a: Row): string => {
          const parts: string[] = [];
          let cursor = Number(a.ParentId);
          const guard = new Set<number>([Number(a.Id)]);
          for (let level = 0; level < 5 && cursor !== 0 && !guard.has(cursor); level++) {
            guard.add(cursor);
            parts.push(`${cursor} ${nameById.get(cursor) ?? ""}`.trim());
            const parentRow = agents.find((x: Row) => Number(x.Id) === cursor);
            cursor = parentRow ? Number(parentRow.ParentId) : 0;
          }
          return parts.join(" ← ") || "üst zincir yok";
        };

        const page = args.page && args.page > 0 ? args.page : 1;
        const pageSize = args.pageSize && args.pageSize > 0 ? args.pageSize : 50;
        const start = (page - 1) * pageSize;
        const rows = filtered.slice(start, start + pageSize).map((a: Row) => ({
          agentId: a.Id,
          agentName: a.AgentName,
          parentId: a.ParentId,
          parentName: a.ParentAgentName,
          agentType: `${a.AgentType} ${AGENT_TYPE_NAMES[Number(a.AgentType)] ?? ""}`.trim(),
          isActive: a.Status,
          parentChain: chainOf(a),
        }));

        const text = serializeFitting(
          { total: agents.length, matched: filtered.length, page, pageSize },
          "agents",
          rows
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 6) igw_values_for_context ★ ──────────────────────────────────────
  server.tool(
    "igw_values_for_context",
    `Verilen bağlam (acente + ek koşullar) altında bir parametrenin değerlerinden hangisinin geçerli olduğunu DEĞERLENDİRİR: her değerin cross'ları bağımlılıklarıyla değerlendirilir; yaşatan-cross'lar ve hedefine eleniş sebebi raporlanır. Cross Değeri 0 = 'bağlamda yok', Ürün -1 = tüm ürünler, Parent ID ≠ 700 = IUP'a kapalı. Bağlam: agentId (istéğbağımlı), üst zincir ajanlardan gelmesin; context'e 'KeyName=Değer' satırları ekleyin (örn. 'Araç Kullanım Şekli=01'). Salt-okunur.`,
    {
      parameterId: z.number().describe("Parametre Id (örn. 4)"),
      companyId: companySchema,
      productId: productSchema,
      agentId: z.number().optional().describe("Acente kodu; bağlam 'Acente ID' ve üst acente (Parent ID) otomatik doldurulur"),
      iupMode: z.boolean().optional().describe("true = bağlam InsurUp Parent (700) altındaki acenteye göre değerlendirilir"),
      context: z
        .array(z.string())
        .optional()
        .describe(`Ek bağlam satırları "KeyName=Değer", ör. ['Araç Kullanım Şekli=01']`),
      valueQuery: z.string().optional().describe("Sadece Text alt kümesiyle eşleşen değerlere bak"),
      refresh: z.boolean().optional().describe("Önbelleği atla"),
    },
    async (args) => {
      try {
        const { parameterName, values } = await parameterValuesWithContext(
          panel,
          args.parameterId,
          args.refresh
        );

        // context
        const { ctx, notes: ctxNotes } = await buildContext(panel, args.agentId, args.context);
        if (args.iupMode) ctx.map.set(KEY_PARENT_ID, IUP_PARENT);

        const agentNames = await getAgentNames(panel);
        const selected = args.valueQuery
          ? values.filter((v) => tr(v.Text).includes(tr(args.valueQuery!)))
          : values;

        const buckets: Array<{
          value: PanelParameterValue;
          applicable: Row[];
          eliminated: Array<Row & { reason: string }>;
          unverifiable: Array<Row & { unevaluated: string }>;
        }> = [];
        for (const v of selected) {
          const bucket = { value: v, applicable: [] as Row[], eliminated: [] as Array<Row & { reason: string }>, unverifiable: [] as Array<Row & { unevaluated: string }> };

          // fetch this value's cross dependencies concurrently (bounded)
          const crosses = v.crosses.filter(
            (c) =>
              companyMatches(c, args.companyId ?? "") &&
              productMatches(c, args.productId)
          );
          const CONCURRENCY = 8;
          const depResults: Array<PanelCrossDependency[]> = new Array(crosses.length);
          const depQueue = crosses.map((c, index) => ({ c, index }));
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, crosses.length) }, async () => {
              for (;;) {
                const item = depQueue.shift();
                if (!item) return;
                const deps = item.c.Dependent
                  ? await panel.getCrossDependencies(item.c.ParameterValueCrossedId)
                  : [];
                depResults[item.index] = deps;
              }
            })
          );

          crosses.forEach((c, index) => {
            const deps = depResults[index] ?? [];
            const row = summarizeCross(c, agentNames);
            if (!c.Dependent) {
              if (String(c.CrossValue) === "0") row.unsupported = true;
              bucket.applicable.push(row);
              return;
            }
            const verdict = evaluateCrossDependencies(deps, ctx);
            const w = iupWarningFor(deps);
            if (verdict.verdict === "pass") {
              if (w) row.iupWarning = w;
              if (String(c.CrossValue) === "0") row.unsupported = true;
              bucket.applicable.push(row);
            } else if (verdict.verdict === "fail") {
              const failedGroups = verdict.groups
                .map((g) =>
                  g.rows
                    .filter((r) => r.verdict === "fail")
                    .map((r) => depFragment(r.dep, agentNames))
                )
                .flat();
              bucket.eliminated.push({
                ...row,
                reason: `koşul sağlanmadı: ${failedGroups.join(", ") || "bilinmeyen"}`,
              });
            } else {
              const unknownNames = verdict.groups
                .flatMap((g) =>
                  g.rows.filter((r) => r.verdict === "unknown").map((r) => r.dep.DependentKeyName)
                )
                .filter((s, i, a) => a.indexOf(s) === i);
              bucket.unverifiable.push({
                ...row,
                unevaluated: `bağlamda eksik koşul: ${unknownNames.join(", ")}`,
              });
            }
          });
          buckets.push(bucket);
        }

        const grouped = buckets.map(({ value: v, applicable, eliminated, unverifiable }) => ({
          valueId: v.Value,
          text: v.Text,
          crossed: v.Crossed,
          active: v.Status,
          applicableCount: applicable.length,
          hasUnsupported: applicable.some((a: Row) => a.unsupported === true),
          applicable: applicable.slice(0, 12),
          eliminatedCount: eliminated.length,
          eliminated: eliminated.slice(0, 8),
          unverifiable: unverifiable.slice(0, 4),
        }));

        const text = serializeFitting(
          {
            parameter: { parameterId: args.parameterId, parameterName },
            context: Object.fromEntries(ctx.map),
            iupMode: Boolean(args.iupMode),
            notes: ctxNotes,
            totalValues: values.length,
            evaluatedValues: selected.length,
            note:
              "'applicable' bağlamda geçerli cross'lardır; CrossValue=0 satırları desteklenmiyor (var ama çalışmıyor) demektir. 'eliminated.reason' hangi koşul yüzünden elendiğini verir; 'unverifiable' bağlamda eksik koşul yüzünden değerlendirilemeyenlerdir.",
          },
          "values",
          grouped
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 7) igw_compare_products ───────────────────────────────────────────
  server.tool(
    "igw_compare_products",
    `Aynı şirketin ÜRÜNLERİNİ bir parametre için karşılaştırır: her parametre değeri × her ürün için cross var mı / CrossValue ne / bağımlı mı. Ürün -1 (Tüm ürünler) tanımı karşılaştırmada HER ürüne uygulanmış sayılır. products argümanı ister sayısal Id ister ad alt kümesi; 2+ ürünle kullanım amaçlıdır. Salt-okunur.`,
    {
      parameterId: z.number().describe("Parametre Id (örn. 4)"),
      companyId: companySchema,
      products: z
        .array(z.string())
        .min(1)
        .describe("Ürün listesi: Id veya ad alt kümesi, örn. ['Standart Kasko','Markalı Kasko']"),
      valueQuery: z.string().optional().describe("Sadece value Text'inde alt küme"),
      agentType: z.number().optional().describe("Acente tipi filtreleri (0..4)"),
      refresh: z.boolean().optional().describe("Önbelleği atla"),
    },
    async (args) => {
      try {
        if (!args.companyId) {
          return {
            content: [{ type: "text", text: "companyId (şirket) zorunludur." }],
            isError: true,
          };
        }
        const { parameterName, values } = await parameterValuesWithContext(panel, args.parameterId, args.refresh);
        const selected = args.valueQuery
          ? values.filter((v) => tr(v.Text).includes(tr(args.valueQuery!)))
          : values;

        const grid = selected.map((v) => {
          const perProduct = args.products.map((p) => {
            const matching = v.crosses.filter(
              (c) =>
                companyMatches(c, args.companyId ?? "") &&
                productMatches(c, p) &&
                (args.agentType == null || c.AgentType === args.agentType)
            );
            const distinctValues = [...new Set(matching.map((c) => String(c.CrossValue)))];
            const wildcardOnly =
              matching.length > 0 && matching.every((c) => Number(c.ProductId) === PRODUCT_ALL);
            return {
              product: p,
              covered: matching.length > 0,
              wildcardOnly,
              crossValues: distinctValues.map((val) =>
                val === "0" ? `${val} (desteklenmeyen)` : val
              ),
              dependent: matching.some((c) => c.Dependent),
              matches: matching.slice(0, 5).map((c) => summarizeCross(c)),
            };
          });
          return {
            valueId: v.Value,
            text: v.Text,
            products: perProduct,
          };
        });

        const text = serializeFitting(
          {
            parameter: { parameterId: args.parameterId, parameterName },
            company: args.companyId,
            products: args.products,
            totalValues: values.length,
            comparedValues: selected.length,
            note:
              "covered=false → o ürün için cross tanımı yok (EKSİK). wildcardOnly=true → yalnızca Ürün Tanımsız (-1) tanımıyla kapalı; 0 → çalışmıyor.",
          },
          "rows",
          grid
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 8) igw_value_trace ────────────────────────────────────────────────
  server.tool(
    "igw_value_trace",
    `Şirkete/ürüne giden bir değerin HANGİ tanımdan geldiğini bulur: key ya da istatistik/ad (örn. Key 17 'IMM Limiti', 608 'IMM Limitleri', 'Araç Kullanım Şekli') + gönderilen değer verin; key'in bağlı olduğu parametrenin cross'larında CrossValue eşleşmesi aranır. Eşleşen her tanım için parametre değeri, cross, bağımlılık (okunabilir) döner. Eşleşme cross'lardan okunur, tahmin yapılmaz. Salt-okunur.`,
    {
      key: z.union([z.number(), z.string()]).describe("Key Id (örn. 17) ya da key adı alt kümesi (örn. 'IMM Limiti')"),
      sentValue: z.string().describe("Şirkete gönderilen değer (örn. '3', '005', '30.000-90.000-30.000')"),
      companyId: companySchema,
      productId: productSchema,
      refresh: z.boolean().optional().describe("Önbelleği atla"),
    },
    async (args) => {
      try {
        if (args.companyId == null) {
          return {
            content: [{ type: "text", text: "companyId (şirket) zorunludur." }],
            isError: true,
          };
        }
        const keys = await panel.getAllKeys(args.refresh === true);
        const s = String(args.key).trim();
        const candidates = keys.filter((k) =>
          /^\d+$/.test(s) ? Number(k.Id) === Number(s) : tr(k.KeyName).includes(tr(s))
        );
        if (candidates.length === 0) {
          return {
            content: [
              { type: "text", text: `"${args.key}" ile eşleşen key bulunamadı.` },
            ],
            isError: true,
          };
        }
        const parameterized = candidates.filter((k) => k.ParameterId != null);
        if (parameterized.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Eşleşen key(ler) parametrik değil; cross araması yapılamaz: ${candidates
                  .slice(0, 10)
                  .map((k) => `${k.Id} ${k.KeyName}`)
                  .join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const agentNames = await getAgentNames(panel);
        const matchesText: Array<Row> = [];
        for (const key of parameterized.slice(0, 8)) {
          const paramId = key.ParameterId as number;
          const values = (await panel.getParameterValues(paramId, args.refresh === true)).filter((v) => v.Crossed);
          // fetch crosses per value concurrently (bounded)
          const CONCURRENCY = 8;
          const crossResults: Array<PanelCross[]> = new Array(values.length);
          const queue = values.map((v, index) => ({ v, index }));
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
              for (;;) {
                const item = queue.shift();
                if (!item) return;
                crossResults[item.index] = await panel.getParameterCrosses(
                  paramId,
                  item.v.Value,
                  args.refresh === true
                );
              }
            })
          );
          values.forEach((v, vi) => {
            const hits = (crossResults[vi] ?? []).filter((c) => {
              if (String(c.CrossValue).trim() !== args.sentValue.trim()) return false;
              if (!companyMatches(c, args.companyId ?? "")) return false;
              if (!productMatches(c, args.productId)) return false;
              return true;
            });
            for (const c of hits) {
              const row = summarizeCross(c, agentNames);
              row.key = { keyId: key.Id, keyName: key.KeyName, parameterId: paramId };
              row.value = { valueId: v.Value, text: v.Text };
              matchesText.push(row);
            }
          });
        }
        // rank product-exact before wildcard
        matchesText.sort(
          (a, b) =>
            Number(String((b.product as string) ?? "").startsWith("TÜM")) -
            Number(String((a.product as string) ?? "").startsWith("TÜM"))
        );

        const text = serializeFitting(
          {
            key: s,
            sentValue: args.sentValue,
            company: args.companyId,
            matched: matchesText.length,
            note:
              "Ürün-Özel tanım, Ürün Tanımsız (-1 · TÜM ÜRÜNLER) satırından önce sıralanır. Hiç eşleşme yoksa şirket bu değeri IGW'ye kendi mapping'inde farklı bir tanımdan yolluyor olabilir (bkz. Faruk notu: gateway API ForAgent ucu insan kontrolü içindir).",
          },
          "matches",
          matchesText
        );
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );

  // 9) igw_crosses_bulk_check ★ ───────────────────────────────────────
  server.tool(
    "igw_crosses_bulk_check",
    `Şirketin gönderdiği teminat/statistik tablosunu IGW tanımlarıyla toplu kontrol eder: satır = ürün (Id ya da ad), istatistik kodu (Key Id ya da adı), değer kodu. Sonuç: her satır için OK (tam eşleşme), OK_GENEL (yalnız Ürün Tanımsız -1 tanımıyla kapalı → 'fazla açık' uyarısı), EKSIK (IGW'de tanım yok), KOD_YOK (key/kod bulunamadı) + şirket seviyesinde FAZLA (tabloda olmayan IGW cross'ları). Çıktı Excel'e aktarılabilir tablo biçimindedir. Salt-okunur.`,
    {
      companyId: companySchema.describe("Şirket: Id ya da ad (zorunlu)"),
      rows: z
        .array(
          z.object({
            product: z.string().optional().describe("Ürün GW Id ya da ad alt kümesi"),
            statCode: z.union([z.number(), z.string()]).optional().describe("İstatistik kodu = Key Id ya da key adı (örn. 608, 'Araç Kullanım Şekli')"),
            valueCode: z.string().describe("Değer kodu = beklenen CrossValue (örn. '005')"),
            vehicleCode: z.string().optional().describe("Araç kodu varsa CrossName içinde aramak için (örn. 'Hususi')"),
          })
        )
        .min(1)
        .describe("Tablo satırları"),
      refresh: z.boolean().optional().describe("Önbelleği atla"),
    },
    async (args) => {
      try {
        if (!args.companyId) {
          return {
            content: [{ type: "text", text: "companyId (şirket) zorunludur." }],
            isError: true,
          };
        }
        const agentNames = await getAgentNames(panel);
        const keys = await panel.getAllKeys(args.refresh === true);
        const paramCache = new Map<number, { parameterName: string; values: Array<PanelParameterValue & { crosses: PanelCross[] }> }>();

        const outRows: Array<Row> = [];
        const seenCrossIds = new Set<string>();
        const companyCollected: PanelCross[] = [];

        for (const r of args.rows) {
          const base = {
            product: r.product ?? "",
            statCode: String(r.statCode ?? ""),
            valueCode: r.valueCode,
            vehicleCode: r.vehicleCode ?? "",
          };
          if (r.statCode == null) {
            outRows.push({ ...base, result: "KOD_YOK", detail: "istatistik kodu boş" });
            continue;
          }
          const s = String(r.statCode).trim();
          const key = keys.find((k) =>
            /^\d+$/.test(s) ? Number(k.Id) === Number(s) : tr(k.KeyName).includes(tr(s))
          );
          if (!key) {
            outRows.push({ ...base, result: "KOD_YOK", detail: `"${s}" key bulunamadı` });
            continue;
          }
          if (key.ParameterId == null) {
            outRows.push({
              ...base,
              key: `${key.Id} ${key.KeyName}`,
              result: "KOD_YOK",
              detail: "key parametrik değil; cross tanımı üzerinden bakılamaz",
            });
            continue;
          }
          const paramId = key.ParameterId;
          if (!paramCache.has(paramId)) {
            paramCache.set(paramId, await parameterValuesWithContext(panel, paramId, args.refresh));
          }
          const pc = paramCache.get(paramId)!;
          const seenValues = new Set<string>(pc.values.map((v) => v.crosses.map((c) => c.ParameterValueCrossedId)).flat().map(String));
          for (const v of pc.values) {
            for (const c of v.crosses) {
              if (companyMatches(c, args.companyId ?? "")) companyCollected.push(c);
            }
          }

          const matches = pc.values.flatMap((v) =>
            v.crosses
              .filter((c) => {
                if (String(c.CrossValue).trim() !== r.valueCode.trim()) return false;
                if (!companyMatches(c, args.companyId ?? "")) return false;
                if (!productMatches(c, r.product)) return false;
                if (r.vehicleCode && !tr(c.CrossName).includes(tr(r.vehicleCode))) return false;
                return true;
              })
              .map((c) => ({ value: v, cross: c }))
          );
          const allForValueCode = pc.values.flatMap((v) =>
            v.crosses.filter(
              (c) =>
                String(c.CrossValue).trim() === r.valueCode.trim() &&
                companyMatches(c, args.companyId ?? "")
            )
          );
          matches.forEach((m) => seenCrossIds.add(String(m.cross.ParameterValueCrossedId)));

          let result: string;
          let detail: string;
          if (matches.length === 0) {
            if (allForValueCode.length > 0) {
              result = "EKSIK";
              detail = `değer kodu var ama ürün bağlamında tanım yok (mevcut ürünler: ${[...new Set(allForValueCode.map((c) => (Number(c.ProductId) === PRODUCT_ALL ? "TÜM ÜRÜNLER" : String(c.ProductId))))].join(", ")})`;
            } else {
              result = "EKSIK";
              detail = `${paramCache.get(paramId)!.parameterName} için kod tanımı bulunamadı`;
            }
          } else if (matches.every((m) => Number(m.cross.ProductId) === PRODUCT_ALL)) {
            result = "OK_GENEL";
            detail = `yalnızca TÜM ÜRÜNLER (-1) tanımıyla kapalı — fazla açık: tablodaki ürün bağlamı kısıtlansa da cross her ürüne açıktır${matches.some((m) => !m.cross.Dependent) ? "; bağımsız (koşulsuz) tanım" : ""}`;
          } else {
            result = "OK";
            detail = `${matches.length} tanım; ${matches[0].value.Text}`;
          }
          outRows.push({
            ...base,
            key: `${key.Id} ${key.KeyName}`,
            parameterId: paramId,
            result,
            crossIds: matches.map((m) => m.cross.ParameterValueCrossedId).slice(0, 5),
            detail,
          });
        }

        // company-level FAZLA: crosses the company defines but this table never matched
        const extra = companyCollected
          .filter((c) => !seenCrossIds.has(String(c.ParameterValueCrossedId)))
          .map((c) => summarizeCross(c, agentNames));

        // simple Excel-friendly TSV
        const tsv = [
          ["Ürün", "İstatistik Kodu", "Değer Kodu", "Araç Kodu", "Key", "Sonuç", "Cross Id", "Açıklama"].join("\t"),
          ...outRows.map((r) =>
            [r.product, r.statCode, r.valueCode, r.vehicleCode, r.key ?? "", r.result, (r.crossIds as number[])?.join(",") ?? "", r.detail].join("\t")
          ),
        ].join("\n");

        const result = {
          company: args.companyId,
          input: args.rows.length,
          ok: outRows.filter((r) => r.result === "OK").length,
          okGenel: outRows.filter((r) => r.result === "OK_GENEL").length,
          missing: outRows.filter((r) => r.result === "EKSIK").length,
          codeNotFound: outRows.filter((r) => r.result === "KOD_YOK").length,
          extraDefinitions: extra.length,
          rows: outRows,
          extra: extra.slice(0, 50),
          note:
            "OK_GENEL 'fazla açık' bulgusudur (Ürün Tanımsız/bağımsız tanımlar). 'extra' IGW'de tanımlı ama bu tabloda satırı olmayan cross'lardır; şirketin fazladan destek sunduğu alanları gösterir.",
          tsv,
        };
        return { content: [{ type: "text", text: truncateResult(result) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    }
  );
}



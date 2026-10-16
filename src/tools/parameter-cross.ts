import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PanelClient } from "../services/panel.js";
import { handleApiError } from "../services/api.js";
import { serializeFitting } from "./panel-lists.js";
import { PanelCross, PanelCrossDependency, PanelKey, PanelParameterValue } from "../types.js";
import {
  AGENT_TYPE_NAMES,
  AgentRow,
  EvaluatedCross,
  EvaluationContext,
  OP_TEXT,
  agentChain,
  agentContext,
  applyContextLines,
  bulkExtras,
  classifyBulkRow,
  closedToIup,
  crossAppliesToProducts,
  describeContext,
  effectiveForValue,
  evaluateDependencies,
  explainVerdict,
  isAllProducts,
  isGenericCross,
  isZeroValue,
  iupZeroWarning,
  reachableByIup,
  renderDependencies,
  setContextValue,
  tr,
  translateCompanyCode,
} from "../services/cross-logic.js";

/**
 * Read-only tools over the GatewayProUI panel's Parameter → Value → Cross →
 * Dependency hierarchy (plus agents). The rules themselves live in
 * services/cross-logic.ts; this file fetches, filters and formats.
 *
 * Panel quirks:
 * - GetParameterValueCrosses returns [] unless both ParameterId and
 *   ParameterValue are posted, so crosses are read one parameter value at
 *   a time (bounded concurrency, cached ~10 min per value).
 * - The cross list does not include Bağımlılık Sırası or "Acenteye özel
 *   mi?"; they exist only in the panel's edit form.
 */

type Row = Record<string, unknown>;

class UserError extends Error {}

const CONCURRENCY = 6;
/** Refuse to walk huge parameters (e.g. "Ürünler", ~2 250 values) without a value filter. */
const MAX_VALUES_SCAN = 300;

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

const fail = (error: unknown) =>
  textResult(error instanceof UserError ? error.message : handleApiError(error), true);

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Lookups ─────────────────────────────────────────────────────────

async function loadAgents(panel: PanelClient, refresh = false): Promise<Map<number, AgentRow>> {
  const rows = await panel.fetchAll<AgentRow>("Agent/GetAgents", refresh);
  return new Map(rows.map((a) => [Number(a.Id), a]));
}

interface Company {
  id: number;
  name: string;
}

/** Resolve a company by Id or name. Ambiguous names are an error, never a guess. */
async function resolveCompany(panel: PanelClient, arg: string): Promise<Company> {
  const rows = await panel.fetchAll<{ Id: number; Name: string }>("InsuranceCompany/GetInsuranceCompanies");
  const s = String(arg ?? "").trim();
  if (!s) throw new UserError("Şirket (companyId) gerekli.");
  if (/^\d+$/.test(s)) {
    const hit = rows.find((r) => Number(r.Id) === Number(s));
    return { id: Number(s), name: hit?.Name ?? `Şirket ${s}` };
  }
  const q = tr(s);
  const tiers = [
    rows.filter((r) => tr(r.Name) === q),
    rows.filter((r) => tr(r.Name).startsWith(q)),
    rows.filter((r) => tr(r.Name).split(/\s+/).includes(q)),
    rows.filter((r) => tr(r.Name).includes(q)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return { id: Number(tier[0].Id), name: tier[0].Name };
    if (tier.length > 1) {
      throw new UserError(
        `"${s}" birden çok şirketle eşleşti; Id verin:\n${tier
          .slice(0, 15)
          .map((r) => `- ${r.Id} ${r.Name}`)
          .join("\n")}`
      );
    }
  }
  throw new UserError(`"${s}" ile eşleşen sigorta şirketi yok.`);
}

interface ProductRef {
  id: number;
  name: string;
}

/** Resolve a product (GW ProductId or name substring) among one company's products. */
async function resolveProducts(panel: PanelClient, company: Company | null, arg: string): Promise<ProductRef[]> {
  const s = String(arg ?? "").trim();
  const all = await panel.getAllProducts();
  if (/^-?\d+$/.test(s)) {
    const hit = all.find((p) => Number(p.Id) === Number(s));
    return [{ id: Number(s), name: hit?.Name ?? (Number(s) === -1 ? "Tüm ürünler" : `Ürün ${s}`) }];
  }
  const own = company ? all.filter((p) => Number(p.InsuranceCompanyId) === company.id) : all;
  const q = tr(s);
  const exact = own.filter((p) => tr(p.Name) === q);
  const hits = exact.length ? exact : own.filter((p) => tr(p.Name).includes(q));
  if (!hits.length) {
    throw new UserError(
      `"${s}" ${company ? `${company.name} ürünlerinde` : "ürün kataloğunda"} bulunamadı; GW ProductId verin.`
    );
  }
  return hits.map((p) => ({ id: Number(p.Id), name: p.Name }));
}

/** Resolve exactly one product, listing candidates when the name is ambiguous. */
async function resolveOneProduct(panel: PanelClient, company: Company, arg: string): Promise<ProductRef> {
  const hits = await resolveProducts(panel, company, arg);
  if (hits.length > 1) {
    throw new UserError(
      `"${arg}" ${company.name} içinde ${hits.length} ürünle eşleşti; Id verin:\n${hits
        .slice(0, 20)
        .map((p) => `- ${p.id} ${p.name}`)
        .join("\n")}`
    );
  }
  return hits[0];
}

function resolveKey(keys: readonly PanelKey[], arg: string | number): PanelKey[] {
  const s = String(arg).trim();
  if (/^\d+$/.test(s)) return keys.filter((k) => Number(k.Id) === Number(s));
  const q = tr(s);
  const exact = keys.filter((k) => tr(k.KeyName) === q);
  return exact.length ? exact : keys.filter((k) => tr(k.KeyName).includes(q));
}

interface ValueWithCrosses {
  value: PanelParameterValue;
  crosses: PanelCross[];
}

/** All values of a parameter with their crosses (optionally only some values). */
async function loadParameter(
  panel: PanelClient,
  parameterId: number,
  refresh: boolean,
  valueFilter?: (v: PanelParameterValue) => boolean
): Promise<{ parameterName: string; values: ValueWithCrosses[]; totalValues: number }> {
  const params = await panel.getAllParameters(refresh);
  const param = params.find((p) => Number(p.ParameterId) === Number(parameterId));
  if (!param) throw new UserError(`Parametre ${parameterId} panelde yok.`);
  const all = await panel.getParameterValues(parameterId, refresh);
  const selected = valueFilter ? all.filter(valueFilter) : all;
  if (selected.length > MAX_VALUES_SCAN) {
    throw new UserError(
      `Parametre ${parameterId} (${param.ParameterName}) ${selected.length} değer içeriyor; tek seferde en fazla ${MAX_VALUES_SCAN} değer taranır. parameterValue ya da valueText ile daraltın.`
    );
  }
  const crosses = await mapLimit(selected, CONCURRENCY, (v) =>
    panel.getParameterCrosses(parameterId, v.Value, refresh)
  );
  return {
    parameterName: param.ParameterName,
    totalValues: all.length,
    values: selected.map((value, i) => ({ value, crosses: crosses[i] ?? [] })),
  };
}

/** Dependency rows for many crosses; unconditional crosses get [] without a request. */
async function loadDependencies(
  panel: PanelClient,
  crosses: readonly PanelCross[],
  refresh: boolean
): Promise<Map<number, PanelCrossDependency[]>> {
  const out = new Map<number, PanelCrossDependency[]>();
  const todo = [...new Map(crosses.map((c) => [c.ParameterValueCrossedId, c])).values()];
  const deps = await mapLimit(todo, CONCURRENCY, (c) =>
    c.Dependent ? panel.getCrossDependencies(c.ParameterValueCrossedId, refresh) : Promise.resolve([])
  );
  todo.forEach((c, i) => out.set(c.ParameterValueCrossedId, deps[i] ?? []));
  return out;
}

function productLabel(c: Pick<PanelCross, "ProductId" | "ProductName">): string {
  return isAllProducts(c) ? "Tüm ürünler (-1)" : `${c.ProductId} ${c.ProductName ?? ""}`.trim();
}

function crossRow(c: PanelCross): Row {
  return {
    crossId: c.ParameterValueCrossedId,
    company: `${c.InsuranceCompanyId} ${c.InsuranceCompanyName ?? ""}`.trim(),
    product: productLabel(c),
    agentType: `${c.AgentType} ${AGENT_TYPE_NAMES[Number(c.AgentType)] ?? ""}`.trim(),
    crossName: c.CrossName,
    crossValue: c.CrossValue,
    ...(isZeroValue(c) ? { unsupported: true } : {}),
    dependent: c.Dependent,
    converged: c.IsConverged,
  };
}

/** Agent + extra "Key=Value" lines → evaluation context. */
function buildContext(
  agents: ReadonlyMap<number, AgentRow>,
  agentId: number | undefined,
  lines: readonly string[] | undefined
): { ctx: EvaluationContext; notes: string[]; chain: string[] } {
  const base = agentContext(agents, agentId);
  const bad = applyContextLines(base.ctx, lines ?? []);
  if (bad.length) base.notes.push(`"Key=Değer" biçiminde olmayan bağlam satırları yok sayıldı: ${bad.join(" | ")}`);
  return base;
}

const NOTE_RULES =
  "Cross Değeri şirkete giden asıl değerdir (logda <kod>…</kod><deger>…</deger>). 0 = bu şirket/ürün/acente bağlamında desteklenmiyor. Ürün -1 (Tanımsız) şirketin tüm ürünlerine uygulanır. Cross İsmi IGW etiketidir, IUP'ta kullanılmaz. Yakınsama alanı IUP'ta kullanılmıyor.";

const companySchema = z.string().describe("Sigorta şirketi: Id (örn. '100') ya da adı (örn. 'Ak Sigorta'). Ad birden çok şirkete uyarsa araç Id ister.");
const productSchema = z
  .string()
  .describe("Ürün: GW ProductId (örn. '3177') ya da şirketin ürün adında geçen metin (örn. 'Standart Kasko').");
const agentSchema = z
  .number()
  .optional()
  .describe("Acente kodu (Acente ID). Verilmezse InsurUp Parent (700) altındaki bir IUP acentesi varsayılır.");
const contextSchema = z
  .array(z.string())
  .optional()
  .describe("Ek bağlam, 'KeyAdı=Değer' ya da 'KeyId=Değer' (IGW değeri), örn. ['Araç Kullanım Şekli=01'].");
const refreshSchema = z.boolean().optional().describe("10 dakikalık önbelleği atlayıp panelden yeniden çek");

export function registerParameterCrossTools(server: McpServer, panel: PanelClient): void {
  // 1) igw_parameter_get ─────────────────────────────────────────────
  server.tool(
    "igw_parameter_get",
    "Bir parametreyi ve tüm değerlerini getirir (Parametre Yönetimi → Parametre Değerleri). parameterId ya da parametre adı ile arayın. Her değer: değer (OriginalValue), ad, cross var mı, Air özel, aktif/pasif. Salt okunur.",
    {
      parameterId: z.number().optional().describe("Parametre Id (örn. 4)"),
      query: z.string().optional().describe("Parametre adında geçen metin (örn. 'IMM')"),
      refresh: refreshSchema,
    },
    async (args) => {
      try {
        const params = await panel.getAllParameters(args.refresh === true);
        let matches = params;
        if (args.parameterId != null) matches = params.filter((p) => Number(p.ParameterId) === args.parameterId);
        else if (args.query) matches = params.filter((p) => tr(p.ParameterName).includes(tr(args.query)));
        else throw new UserError("parameterId ya da query gerekli.");
        if (!matches.length) throw new UserError("Eşleşen parametre yok.");
        if (matches.length > 1) {
          throw new UserError(
            `${matches.length} parametre eşleşti; parameterId verin:\n${matches
              .slice(0, 25)
              .map((m) => `- ${m.ParameterId} ${m.ParameterName}${m.Dependent ? " (bağımlı)" : ""}`)
              .join("\n")}`
          );
        }
        const p = matches[0];
        const values = await panel.getParameterValues(p.ParameterId, args.refresh === true);
        const keys = (await panel.getAllKeys()).filter((k) => Number(k.ParameterId) === Number(p.ParameterId));
        const rows = values.map((v) => ({
          value: v.Value,
          name: v.Text,
          crossed: v.Crossed,
          airSpecific: v.IsAirSpecific,
          active: v.Status,
        }));
        return textResult(
          serializeFitting(
            {
              parameter: { id: p.ParameterId, name: p.ParameterName, dependent: p.Dependent },
              keys: keys.map((k) => `${k.Id} ${k.KeyName}`),
              totalValues: values.length,
              activeValues: values.filter((v) => v.Status).length,
            },
            "values",
            rows
          )
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 2) igw_crosses_list ──────────────────────────────────────────────
  server.tool(
    "igw_crosses_list",
    "Bir parametrenin (istenirse tek değerinin) cross'larını listeler: şirket, ürün (-1 = tüm ürünler), acente tipi, cross ismi, cross değeri, bağımlı mı, yakınsama. includeDependencies=true ile dönen sayfadaki her cross'un bağımlılıkları okunabilir ifadeyle gelir. IUP acentelerine (Parent 700) açık bir cross'ta değer 0 ise satır 'warning' taşır. Salt okunur.",
    {
      parameterId: z.number().describe("Parametre Id (örn. 4 = IMM Limitleri)"),
      parameterValue: z.string().optional().describe("Tek parametre değeri (OriginalValue, örn. '3')"),
      valueText: z.string().optional().describe("Değer adında geçen metin (örn. '30.000')"),
      companyId: companySchema.optional(),
      productId: productSchema.optional(),
      agentType: z.number().optional().describe("Acente tipi: 0 Tanımsız, 1 Acente, 2 Broker, 3 Banka, 4 Sigorta Şirketi"),
      crossValue: z.string().optional().describe("Cross değeri tam eşleşme (örn. '005', '0')"),
      crossName: z.string().optional().describe("Cross isminde geçen metin"),
      dependent: z.boolean().optional().describe("true = yalnız bağımlı, false = yalnız bağımsız cross'lar"),
      onlyWarnings: z.boolean().optional().describe("Yalnız IUP'a açık 0 uyarısı olan cross'lar"),
      includeDependencies: z.boolean().optional().describe("Dönen sayfadaki cross'ların bağımlılıklarını okunabilir ifadeyle ekle"),
      refresh: refreshSchema,
      page: z.number().optional().describe("Sayfa (varsayılan 1)"),
      pageSize: z.number().optional().describe("Sayfa boyutu (varsayılan 50)"),
    },
    async (args) => {
      try {
        const refresh = args.refresh === true;
        const company = args.companyId ? await resolveCompany(panel, args.companyId) : null;
        const productIds = args.productId
          ? new Set((await resolveProducts(panel, company, args.productId)).map((p) => p.id))
          : null;
        const loaded = await loadParameter(panel, args.parameterId, refresh, (v) => {
          if (args.parameterValue != null && v.Value !== args.parameterValue) return false;
          if (args.valueText && !tr(v.Text).includes(tr(args.valueText))) return false;
          return true;
        });
        const agents = await loadAgents(panel);

        const filtered = loaded.values.flatMap(({ value, crosses }) =>
          crosses
            .filter((c) => {
              if (company && Number(c.InsuranceCompanyId) !== company.id) return false;
              if (!crossAppliesToProducts(c, productIds)) return false;
              if (args.agentType != null && Number(c.AgentType) !== args.agentType) return false;
              if (args.crossValue != null && String(c.CrossValue).trim() !== args.crossValue.trim()) return false;
              if (args.crossName && !tr(c.CrossName).includes(tr(args.crossName))) return false;
              if (args.dependent != null && c.Dependent !== args.dependent) return false;
              return true;
            })
            .map((c) => ({ value, c }))
        );

        // 0 warnings need the dependencies of every zero cross in the result.
        const zeroDeps = await loadDependencies(
          panel,
          filtered.filter((x) => isZeroValue(x.c)).map((x) => x.c),
          refresh
        );
        const warningOf = (c: PanelCross): string | null =>
          isZeroValue(c) ? iupZeroWarning(c, zeroDeps.get(c.ParameterValueCrossedId) ?? []) : null;
        const visible = args.onlyWarnings ? filtered.filter((x) => warningOf(x.c)) : filtered;

        const page = args.page && args.page > 0 ? args.page : 1;
        const pageSize = args.pageSize && args.pageSize > 0 ? args.pageSize : 50;
        const slice = visible.slice((page - 1) * pageSize, page * pageSize);
        const deps = args.includeDependencies
          ? await loadDependencies(panel, slice.map((x) => x.c), refresh)
          : new Map<number, PanelCrossDependency[]>();

        const rows = slice.map(({ value, c }) => {
          const row: Row = { parameterValue: `${value.Value} ${value.Text}`, ...crossRow(c) };
          const d = deps.get(c.ParameterValueCrossedId) ?? zeroDeps.get(c.ParameterValueCrossedId);
          if (args.includeDependencies && d) {
            row.dependency = renderDependencies(d, agents);
            if (closedToIup(d)) row.iupClosed = true;
          }
          const w = warningOf(c);
          if (w) row.warning = w;
          return row;
        });

        return textResult(
          serializeFitting(
            {
              parameter: { id: args.parameterId, name: loaded.parameterName },
              company: company ? `${company.id} ${company.name}` : null,
              valuesScanned: loaded.values.length,
              matched: visible.length,
              zeroWarnings: filtered.filter((x) => warningOf(x.c)).length,
              page,
              pageSize,
              note: NOTE_RULES,
            },
            "crosses",
            rows
          )
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 3) igw_cross_dependencies ────────────────────────────────────────
  server.tool(
    "igw_cross_dependencies",
    "Tek bir cross'un (ParameterValueCrossedId) bağımlılık satırlarını getirir: bağımlı key, bağlı key değeri, bağlılık tipi (=, ≠, >, <, [==] barındırıyor, [!=] barındırmıyor), grup no, grup içi ve gruplar arası bağlantı (&& / ||), bağımlılık seviyesi. Okunabilir ifade, IUP'a kapalı olup olmadığı ve 0 uyarısı da döner. Salt okunur.",
    {
      crossId: z.number().describe("ParameterValueCrossedId (igw_crosses_list çıktısındaki crossId)"),
      refresh: refreshSchema,
    },
    async (args) => {
      try {
        const deps = await panel.getCrossDependencies(args.crossId, args.refresh === true);
        const agents = await loadAgents(panel);
        const first = deps[0];
        const zero = first ? iupZeroWarning({ CrossValue: first.CrossValue }, deps) : null;
        return textResult(
          serializeFitting(
            {
              crossId: args.crossId,
              crossValue: first?.CrossValue ?? null,
              readable: renderDependencies(deps, agents),
              iupClosed: closedToIup(deps),
              reachableByIup: deps.length ? reachableByIup(deps) : null,
              ...(zero ? { warning: zero } : {}),
              ...(deps.length
                ? {}
                : { note: "Bağımlılık satırı yok: cross koşulsuz ya da crossId hatalı." }),
            },
            "dependencies",
            deps.map((d) => ({
              id: d.Id,
              dependentKey: `${d.DependentKeyId} ${d.DependentKeyName}`,
              operator: `${d.DependencyType} (${OP_TEXT[d.DependencyType] ?? "?"})`,
              value: d.DependentKeyValue,
              groupNo: d.DependencyGroupNo,
              connectionToNextRow: d.DependencyConnectionTypeToOtherKey || null,
              connectionToNextGroup: d.DependencyGroupConnectionTypeToOtherGroup || null,
              executionLevel: d.DependencyExecutionLevelForOtherKey,
            }))
          )
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 4) igw_key_dependencies ──────────────────────────────────────────
  server.tool(
    "igw_key_dependencies",
    "Bir key'in bağımlılıklarını getirir (Key ekranındaki mavi ikonun açtığı tablo): hangi key'in hangi değerine bağlı olduğu, bağlılık tipi, bağlantı ve seviye. Salt okunur.",
    {
      keyId: z.number().describe("Key Id (örn. 36 = Araç LPG Bedeli)"),
      refresh: refreshSchema,
    },
    async (args) => {
      try {
        const [deps, keys] = await Promise.all([
          panel.getKeyDependencies(args.keyId, args.refresh === true),
          panel.getAllKeys(),
        ]);
        const key = keys.find((k) => Number(k.Id) === args.keyId);
        const readable = deps
          .map((d, i) => {
            const part = `${d.DependentKeyName} (Key ${d.DependentKeyId}) ${OP_TEXT[d.DependencyType] ?? d.DependencyType} ${d.DependentKeyValue}`;
            const conn = String(d.DependencyConnectionTypeToOtherKey ?? "").trim();
            return i < deps.length - 1 ? `${part} ${conn === "||" ? "VEYA" : "VE"}` : part;
          })
          .join(" ");
        return textResult(
          serializeFitting(
            {
              keyId: args.keyId,
              keyName: key?.KeyName ?? null,
              readable: readable || "Bu key'in bağımlılığı yok.",
            },
            "dependencies",
            deps.map((d) => ({
              id: d.Id,
              dependentKey: `${d.DependentKeyId} ${d.DependentKeyName}`,
              operator: `${d.DependencyType} (${OP_TEXT[d.DependencyType] ?? "?"})`,
              value: d.DependentKeyValue,
              connectionToNextRow: d.DependencyConnectionTypeToOtherKey || null,
              executionLevel: d.DependencyExecutionLevelForOtherKey,
            }))
          )
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 5) igw_agents_search ─────────────────────────────────────────────
  server.tool(
    "igw_agents_search",
    "IGW acente listesinde arar (~2 800 kayıt): acente kodu, adı, üst acente kodu/adı, acente tipi, aktif/pasif ve üst acente zinciri. Özel kayıtlar: 700 InsurUp Parent (IUP acenteleri bunun altında), -999 SigortaPro Parent, -900 BrokerPro Parent, 0 All Agents. Filtreler VE ile birleşir. Salt okunur.",
    {
      query: z.string().optional().describe("Acente adında geçen metin (örn. 'VDF', 'Sencard')"),
      agentId: z.number().optional().describe("Acente kodu (örn. 11588)"),
      parentId: z.number().optional().describe("Üst acente kodu (örn. 700)"),
      parentName: z.string().optional().describe("Üst acente adında geçen metin"),
      agentType: z.number().optional().describe("Acente tipi: 0 Tanımsız, 1 Acente, 2 Broker, 3 Banka, 4 Sigorta Şirketi"),
      isActive: z.boolean().optional().describe("true = aktif, false = pasif"),
      refresh: refreshSchema,
      page: z.number().optional().describe("Sayfa (varsayılan 1)"),
      pageSize: z.number().optional().describe("Sayfa boyutu (varsayılan 50)"),
    },
    async (args) => {
      try {
        const agents = await loadAgents(panel, args.refresh === true);
        const filtered = [...agents.values()].filter((a) => {
          if (args.agentId != null && Number(a.Id) !== args.agentId) return false;
          if (args.query && !tr(a.AgentName).includes(tr(args.query))) return false;
          if (args.parentId != null && Number(a.ParentId) !== args.parentId) return false;
          if (args.parentName && !tr(a.ParentAgentName).includes(tr(args.parentName))) return false;
          if (args.agentType != null && Number(a.AgentType) !== args.agentType) return false;
          if (args.isActive != null && Boolean(a.Status) !== args.isActive) return false;
          return true;
        });
        const page = args.page && args.page > 0 ? args.page : 1;
        const pageSize = args.pageSize && args.pageSize > 0 ? args.pageSize : 50;
        const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map((a) => ({
          agentId: a.Id,
          agentName: a.AgentName,
          parentId: a.ParentId,
          parentName: a.ParentAgentName,
          agentType: `${a.AgentType} ${AGENT_TYPE_NAMES[Number(a.AgentType)] ?? ""}`.trim(),
          active: a.Status,
          parentChain: agentChain(agents, Number(a.Id))
            .map((p) => `${p.Id} ${p.AgentName}`)
            .join(" → ") || "üst acente yok",
          underInsurUp: agentChain(agents, Number(a.Id)).some((p) => Number(p.Id) === 700),
        }));
        return textResult(serializeFitting({ total: agents.size, matched: filtered.length, page, pageSize }, "agents", rows));
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 6) igw_values_for_context ★ ──────────────────────────────────────
  server.tool(
    "igw_values_for_context",
    "Bir şirket + ürün + bağlam için parametrenin hangi değerlerinin gerçekten geçerli olduğunu bağımlılıkları değerlendirerek bulur. Her değer için durum: GECERLI (şirkete giden değer), DESTEKLENMIYOR (geçerli tanım 0), TANIM_YOK, BELIRSIZ (bağlamda eksik koşul). Elenen her cross için hangi koşul yüzünden elendiği yazılır. Acente verilmezse InsurUp Parent (700) altındaki bir IUP acentesi varsayılır; acente verilirse Acente ID ve üst acente (Parent ID) otomatik doldurulur. 'Acente X değeri istiyor, tanımlı mı, neden görünmüyor?' sorusu için kullanın. Salt okunur.",
    {
      parameterId: z.number().describe("Parametre Id (örn. 4)"),
      companyId: companySchema,
      productId: productSchema,
      agentId: agentSchema,
      context: contextSchema,
      parameterValue: z.string().optional().describe("Yalnız bu parametre değeri (OriginalValue)"),
      valueText: z.string().optional().describe("Yalnız adında bu metin geçen değerler (örn. '50.000')"),
      status: z
        .enum(["GECERLI", "DESTEKLENMIYOR", "TANIM_YOK", "BELIRSIZ"])
        .optional()
        .describe("Yalnız bu durumdaki değerleri döndür"),
      refresh: refreshSchema,
    },
    async (args) => {
      try {
        const refresh = args.refresh === true;
        const company = await resolveCompany(panel, args.companyId);
        const product = await resolveOneProduct(panel, company, args.productId);
        const productIds = new Set([product.id]);
        const agents = await loadAgents(panel);
        const { ctx, notes, chain } = buildContext(agents, args.agentId, args.context);
        const loaded = await loadParameter(panel, args.parameterId, refresh, (v) => {
          if (args.parameterValue != null && v.Value !== args.parameterValue) return false;
          if (args.valueText && !tr(v.Text).includes(tr(args.valueText))) return false;
          return true;
        });

        const relevant = loaded.values.map(({ value, crosses }) => ({
          value,
          crosses: crosses.filter(
            (c) => Number(c.InsuranceCompanyId) === company.id && crossAppliesToProducts(c, productIds)
          ),
        }));
        const deps = await loadDependencies(panel, relevant.flatMap((r) => r.crosses), refresh);

        const results = relevant.map(({ value, crosses }) => {
          const evaluated: EvaluatedCross[] = crosses.map((c) => {
            const d = deps.get(c.ParameterValueCrossedId) ?? [];
            return { cross: c, deps: d, result: evaluateDependencies(d, ctx) };
          });
          const eff = effectiveForValue(value.Value, evaluated);
          const winner = eff.effective;
          const warning =
            winner && isZeroValue(winner.cross) ? iupZeroWarning(winner.cross, winner.deps) : null;
          return {
            value: value.Value,
            name: value.Text,
            active: value.Status,
            status: eff.status,
            sentValue: winner ? winner.cross.CrossValue : null,
            ...(winner
              ? {
                  effectiveCross: {
                    crossId: winner.cross.ParameterValueCrossedId,
                    product: productLabel(winner.cross),
                    dependency: renderDependencies(winner.deps, agents),
                    generic: isGenericCross(winner.cross),
                  },
                }
              : {}),
            ...(eff.ambiguous ? { ambiguous: "Eşit öncelikli, farklı değer gönderen birden çok tanım var" } : {}),
            ...(warning ? { warning } : {}),
            eliminated: eff.failing.map((e) => ({
              crossId: e.cross.ParameterValueCrossedId,
              crossValue: e.cross.CrossValue,
              product: productLabel(e.cross),
              reason: explainVerdict(e.result, agents),
            })),
            undecided: eff.unknown.map((e) => ({
              crossId: e.cross.ParameterValueCrossedId,
              crossValue: e.cross.CrossValue,
              reason: explainVerdict(e.result, agents),
            })),
            ...(eff.passing.length > 1
              ? {
                  alsoPassing: eff.passing
                    .filter((p) => p !== winner)
                    .map((p) => ({ crossId: p.cross.ParameterValueCrossedId, crossValue: p.cross.CrossValue, product: productLabel(p.cross) })),
                }
              : {}),
          };
        });
        const visible = args.status ? results.filter((r) => r.status === args.status) : results;
        const count = (s: string) => results.filter((r) => r.status === s).length;

        return textResult(
          serializeFitting(
            {
              parameter: { id: args.parameterId, name: loaded.parameterName },
              company: `${company.id} ${company.name}`,
              product: `${product.id} ${product.name}`,
              context: describeContext(ctx),
              agentChain: chain,
              notes,
              summary: {
                GECERLI: count("GECERLI"),
                DESTEKLENMIYOR: count("DESTEKLENMIYOR"),
                TANIM_YOK: count("TANIM_YOK"),
                BELIRSIZ: count("BELIRSIZ"),
              },
              note:
                NOTE_RULES +
                " Birden çok cross geçerse ürüne özel tanım 'Tüm ürünler'den, koşullu tanım koşulsuzdan önce sayılır; panel listesi Bağımlılık Sırası alanını vermediği için bu öncelik yaklaşıktır. Panel doğru görünüp değer IUP'ta görünmüyorsa Postman'den GET https://gatewayapi.insurapps.net/api/parameters/{parameterId}/CrossValues/InsuranceCompanies/{companyId}/ForAgent?includeNotAgentDependent=true ucuna bakılmasını önerin (MCP bu uca bağlanmaz).",
            },
            "values",
            visible
          )
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 7) igw_compare_products ──────────────────────────────────────────
  server.tool(
    "igw_compare_products",
    "Aynı şirketin ürünlerini bir parametre için karşılaştırır: her değer × ürün için o bağlamda şirkete giden değer (yoksa TANIM_YOK, 0 ise DESTEKLENMIYOR). Ürün -1 (Tanımsız) tanımı her ürüne uygulanır. Ürünler Id ya da ad ile verilir; ad birden çok ürüne uyarsa hepsi ayrı sütun olur. Varsayılan olarak yalnız ürünler arasında fark olan değerler döner. Bağlam varsayılanı 700 altındaki IUP acentesidir. Salt okunur.",
    {
      parameterId: z.number().describe("Parametre Id (örn. 4)"),
      companyId: companySchema,
      products: z.array(z.string()).min(1).describe("Ürünler: GW Id ya da ad, örn. ['Standart Kasko', 'Markalı Kasko']"),
      agentId: agentSchema,
      context: contextSchema,
      valueText: z.string().optional().describe("Yalnız adında bu metin geçen değerler"),
      onlyDifferences: z.boolean().optional().describe("Yalnız ürünler arasında fark olan değerler (varsayılan true)"),
      refresh: refreshSchema,
    },
    async (args) => {
      try {
        const refresh = args.refresh === true;
        const company = await resolveCompany(panel, args.companyId);
        const products: ProductRef[] = [];
        for (const p of args.products) {
          for (const r of await resolveProducts(panel, company, p)) {
            if (!products.some((x) => x.id === r.id)) products.push(r);
          }
        }
        if (products.length > 12) {
          throw new UserError(
            `Ürün listesi ${products.length} ürüne açıldı (en fazla 12); daha dar ad ya da Id verin:\n${products
              .slice(0, 30)
              .map((p) => `- ${p.id} ${p.name}`)
              .join("\n")}`
          );
        }
        const agents = await loadAgents(panel);
        const { ctx, notes } = buildContext(agents, args.agentId, args.context);
        const loaded = await loadParameter(panel, args.parameterId, refresh, (v) =>
          args.valueText ? tr(v.Text).includes(tr(args.valueText)) : true
        );
        const companyCrosses = loaded.values.flatMap((v) =>
          v.crosses.filter((c) => Number(c.InsuranceCompanyId) === company.id)
        );
        const deps = await loadDependencies(panel, companyCrosses, refresh);

        const rows = loaded.values.map(({ value, crosses }) => {
          const perProduct = products.map((p) => {
            const evaluated: EvaluatedCross[] = crosses
              .filter((c) => Number(c.InsuranceCompanyId) === company.id && crossAppliesToProducts(c, new Set([p.id])))
              .map((c) => {
                const d = deps.get(c.ParameterValueCrossedId) ?? [];
                return { cross: c, deps: d, result: evaluateDependencies(d, ctx) };
              });
            const eff = effectiveForValue(value.Value, evaluated);
            return {
              product: `${p.id} ${p.name}`,
              status: eff.status,
              sentValue: eff.effective?.cross.CrossValue ?? null,
              via: eff.effective
                ? isAllProducts(eff.effective.cross)
                  ? "Tüm ürünler (-1)"
                  : "ürüne özel"
                : null,
              crossId: eff.effective?.cross.ParameterValueCrossedId ?? null,
            };
          });
          const signature = new Set(perProduct.map((x) => `${x.status}|${x.sentValue}`));
          return { value: value.Value, name: value.Text, differs: signature.size > 1, products: perProduct };
        });
        const onlyDiff = args.onlyDifferences !== false;
        const visible = onlyDiff ? rows.filter((r) => r.differs) : rows;
        return textResult(
          serializeFitting(
            {
              parameter: { id: args.parameterId, name: loaded.parameterName },
              company: `${company.id} ${company.name}`,
              products: products.map((p) => `${p.id} ${p.name}`),
              context: describeContext(ctx),
              notes,
              comparedValues: rows.length,
              differingValues: rows.filter((r) => r.differs).length,
              note: NOTE_RULES,
            },
            "values",
            visible
          )
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 8) igw_value_trace ───────────────────────────────────────────────
  server.tool(
    "igw_value_trace",
    "Teklif logunda şirkete giden bir değerin hangi IGW tanımından geldiğini bulur. Key (Id ya da ad) ve logdaki değeri (<deger>…</deger>) verin; key'in parametresindeki cross'larda Cross Değeri bu değer olanlar, parametre değeri, ürün, bağımlılığın okunabilir hâli ve verilen bağlamda bu tanımın gerçekten seçilip seçilmediğiyle döner. Şirket kodu (örn. ANK, 608) key değildir; önce hangi key'e karşılık geldiğini bulun. Salt okunur.",
    {
      key: z.union([z.number(), z.string()]).describe("Key Id (örn. 17) ya da key adı (örn. 'IMM Limiti')"),
      sentValue: z.string().describe("Şirkete giden değer, logdaki <deger> (örn. '005')"),
      companyId: companySchema,
      productId: productSchema.optional(),
      agentId: agentSchema,
      context: contextSchema,
      refresh: refreshSchema,
    },
    async (args) => {
      try {
        const refresh = args.refresh === true;
        const company = await resolveCompany(panel, args.companyId);
        const product = args.productId ? await resolveOneProduct(panel, company, args.productId) : null;
        const productIds = product ? new Set([product.id]) : null;
        const keys = await panel.getAllKeys(refresh);
        const candidates = resolveKey(keys, args.key);
        if (!candidates.length) throw new UserError(`"${args.key}" ile eşleşen key yok.`);
        const parameterized = candidates.filter((k) => k.ParameterId != null);
        if (!parameterized.length) {
          throw new UserError(
            `Eşleşen key(ler) parametrik değil, cross'u yok: ${candidates.slice(0, 10).map((k) => `${k.Id} ${k.KeyName}`).join(", ")}`
          );
        }
        if (parameterized.length > 5) {
          throw new UserError(
            `"${args.key}" ${parameterized.length} parametrik key'e uydu; Key Id verin:\n${parameterized
              .slice(0, 20)
              .map((k) => `- ${k.Id} ${k.KeyName} (parametre ${k.ParameterId})`)
              .join("\n")}`
          );
        }
        const agents = await loadAgents(panel);
        const { ctx, notes } = buildContext(agents, args.agentId, args.context);
        const target = args.sentValue.trim();
        const matches: Row[] = [];

        for (const key of parameterized) {
          const loaded = await loadParameter(panel, Number(key.ParameterId), refresh, (v) => v.Crossed);
          for (const { value, crosses } of loaded.values) {
            const own = crosses.filter(
              (c) => Number(c.InsuranceCompanyId) === company.id && crossAppliesToProducts(c, productIds)
            );
            if (!own.some((c) => String(c.CrossValue).trim() === target)) continue;
            const deps = await loadDependencies(panel, own, refresh);
            const evaluated: EvaluatedCross[] = own.map((c) => {
              const d = deps.get(c.ParameterValueCrossedId) ?? [];
              return { cross: c, deps: d, result: evaluateDependencies(d, ctx) };
            });
            const eff = productIds ? effectiveForValue(value.Value, evaluated) : null;
            for (const e of evaluated.filter((x) => String(x.cross.CrossValue).trim() === target)) {
              matches.push({
                key: `${key.Id} ${key.KeyName}`,
                parameter: `${loaded.parameterName} (${key.ParameterId})`,
                parameterValue: `${value.Value} ${value.Text}`,
                ...crossRow(e.cross),
                dependency: renderDependencies(e.deps, agents),
                inContext: e.result.verdict,
                ...(e.result.verdict !== "pass" ? { reason: explainVerdict(e.result, agents) } : {}),
                ...(eff ? { selectedInContext: eff.effective === e } : {}),
                ...(iupZeroWarning(e.cross, e.deps) ? { warning: iupZeroWarning(e.cross, e.deps) } : {}),
              });
            }
          }
        }
        matches.sort(
          (a, b) =>
            Number(a.inContext !== "pass") - Number(b.inContext !== "pass") ||
            Number(String(a.product).startsWith("Tüm")) - Number(String(b.product).startsWith("Tüm"))
        );
        return textResult(
          serializeFitting(
            {
              key: String(args.key),
              sentValue: target,
              company: `${company.id} ${company.name}`,
              product: product ? `${product.id} ${product.name}` : "belirtilmedi (tüm ürünler)",
              context: describeContext(ctx),
              notes,
              matched: matches.length,
              note:
                (target === "0"
                  ? "Aranan değer 0: bu tanımlar 'desteklenmiyor' anlamına gelir, şirkete gerçek bir değer gitmez. "
                  : "") +
                "inContext=pass olan ve selectedInContext=true olan satır, verilen bağlamda değerin geldiği tanımdır. Eşleşme yoksa değer bu key'in cross'larından gelmiyor; başka bir key ya da şirket tarafı eşleme olabilir.",
            },
            "matches",
            matches
          )
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 9) igw_crosses_bulk_check ★ ──────────────────────────────────────
  server.tool(
    "igw_crosses_bulk_check",
    `Şirketin teminat/istatistik tablosunu (örn. Ak Sigorta KASKO_ISTATISTIK_LISTESI) IGW tanımlarıyla toplu karşılaştırır ve IGW'ye açılacak talepler için bulgu listesi üretir.

Eşleme kuralları (tahmin yapılmaz):
- İstatistik kodu (608, ANK…) şirketin kodudur, Key Id değildir. Her satır ya 'key' (IGW Key Id/adı) taşır ya da codeMap ile istatistik kodu → key eşlemesi verilir. Eşlemesi olmayan kod KOD_YOK olur.
- Şirketin ürün ve araç kodları productKey / vehicleKey ile verilen key'in parametre cross'larından IGW değerine çevrilir (Cross Değeri = şirket kodu). Karşılığı olmayan kod KOD_YOK bulgusudur. İstenirse ürün doğrudan GW ProductId/adı ile (product) verilir.
- Her satır şirket + ürün + bağlam (varsayılan: 700 altındaki IUP acentesi) için bağımlılıklar değerlendirilerek kontrol edilir.

Sonuçlar: OK, EKSIK (IGW'de yok, 0 ya da elenmiş), BELIRSIZ (bağlamda eksik koşul), KOD_YOK, FAZLA (IGW gönderiyor, tabloda yok), FAZLA_ACIK (Ürün Tanımsız -1 ya da koşulsuz tanım yüzünden fazla açık), UYARI_0 (IUP'a açık tanım 0 gönderiyor). Çıktıda Excel'e yapıştırılabilir TSV vardır. Salt okunur.`,
    {
      companyId: companySchema,
      agentId: agentSchema,
      codeMap: z
        .array(z.object({ code: z.string().describe("Şirketin istatistik kodu, örn. '608', 'ANK'"), key: z.union([z.number(), z.string()]).describe("IGW Key Id ya da adı") }))
        .optional()
        .describe("İstatistik kodu → IGW key eşlemesi"),
      productKey: z.union([z.number(), z.string()]).optional().describe("Şirket ürün kodunu çevirecek IGW key (Id/ad); satırda productCode varsa gerekli"),
      vehicleKey: z.union([z.number(), z.string()]).optional().describe("Şirket araç kodunu çevirecek IGW key (Id/ad, örn. 38 'Araç Kullanım Şekli'); satırda vehicleCode varsa gerekli"),
      rows: z
        .array(
          z.object({
            statCode: z.string().optional().describe("Şirketin istatistik kodu (codeMap ile key'e çevrilir)"),
            key: z.union([z.number(), z.string()]).optional().describe("Doğrudan IGW Key Id/adı (statCode yerine)"),
            valueCode: z.string().describe("Şirketin beklediği değer kodu = beklenen Cross Değeri (örn. '005')"),
            product: z.string().optional().describe("GW ProductId ya da ürün adı"),
            productCode: z.string().optional().describe("Şirketin ürün kodu (productKey ile çevrilir, örn. Ak 660 değeri '000')"),
            vehicleCode: z.string().optional().describe("Şirketin araç kodu (vehicleKey ile çevrilir, örn. '001')"),
            context: z.array(z.string()).optional().describe("Satıra özel ek bağlam 'Key=IGW değeri'"),
          })
        )
        .min(1)
        .describe("Tablo satırları"),
      includeExtras: z.boolean().optional().describe("FAZLA / FAZLA_ACIK / UYARI_0 bulgularını üret (varsayılan true)"),
      refresh: refreshSchema,
    },
    async (args) => {
      try {
        const refresh = args.refresh === true;
        const company = await resolveCompany(panel, args.companyId);
        const agents = await loadAgents(panel);
        const keys = await panel.getAllKeys(refresh);

        const paramCache = new Map<number, Awaited<ReturnType<typeof loadParameter>>>();
        const depCache = new Map<number, PanelCrossDependency[]>();
        const getParam = async (id: number) => {
          if (!paramCache.has(id)) paramCache.set(id, await loadParameter(panel, id, refresh));
          return paramCache.get(id)!;
        };
        const companyCrossesByValue = async (parameterId: number) => {
          const p = await getParam(parameterId);
          return new Map(
            p.values.map((v) => [v.value.Value, v.crosses.filter((c) => Number(c.InsuranceCompanyId) === company.id)])
          );
        };
        const oneKey = (arg: string | number, label: string): PanelKey => {
          const hits = resolveKey(keys, arg);
          if (hits.length !== 1) {
            throw new UserError(
              `${label} "${arg}" ${hits.length ? `${hits.length} key'e uydu; Key Id verin` : "ile eşleşen key yok"}.`
            );
          }
          if (hits[0].ParameterId == null) throw new UserError(`${label} ${hits[0].Id} ${hits[0].KeyName} parametrik değil.`);
          return hits[0];
        };
        const productKey = args.productKey != null ? oneKey(args.productKey, "productKey") : null;
        const vehicleKey = args.vehicleKey != null ? oneKey(args.vehicleKey, "vehicleKey") : null;
        const codeMap = new Map((args.codeMap ?? []).map((m) => [m.code.trim(), m.key]));

        interface Group {
          label: string;
          key: PanelKey;
          parameterId: number;
          ctx: EvaluationContext;
          productIds: Set<number> | null;
          codes: Set<string>;
          rowLabel: Row;
        }
        const groups = new Map<string, Group>();
        const findings: Row[] = [];

        const translate = async (
          k: PanelKey,
          code: string
        ): Promise<{ ok: true; value: string } | { ok: false; detail: string }> => {
          const byValue = await companyCrossesByValue(Number(k.ParameterId));
          const hits = translateCompanyCode(code, byValue);
          if (!hits.length) return { ok: false, detail: `${k.KeyName} (Key ${k.Id}) cross'larında şirket kodu '${code}' karşılığı yok` };
          if (hits.length > 1) return { ok: false, detail: `${k.KeyName} (Key ${k.Id}) için şirket kodu '${code}' birden çok IGW değerine gidiyor: ${hits.join(", ")}` };
          return { ok: true, value: hits[0] };
        };

        for (const r of args.rows) {
          const base: Row = {
            statCode: r.statCode ?? "",
            product: r.product ?? r.productCode ?? "",
            vehicle: r.vehicleCode ?? "",
            valueCode: r.valueCode,
          };
          const keyArg = r.key ?? (r.statCode != null ? codeMap.get(r.statCode.trim()) : undefined);
          if (keyArg == null) {
            findings.push({ ...base, result: "KOD_YOK", detail: `İstatistik kodu '${r.statCode ?? ""}' için key eşlemesi yok (codeMap ya da key verin)` });
            continue;
          }
          const keyHits = resolveKey(keys, keyArg).filter((k) => k.ParameterId != null);
          if (keyHits.length !== 1) {
            findings.push({ ...base, result: "KOD_YOK", detail: `Key '${keyArg}' ${keyHits.length ? "birden çok parametrik key'e uydu" : "bulunamadı ya da parametrik değil"}` });
            continue;
          }
          const key = keyHits[0];
          const { ctx } = buildContext(agents, args.agentId, r.context);

          let productIds: Set<number> | null = null;
          if (r.product) {
            try {
              productIds = new Set((await resolveProducts(panel, company, r.product)).map((p) => p.id));
            } catch (e) {
              findings.push({ ...base, key: `${key.Id} ${key.KeyName}`, result: "KOD_YOK", detail: (e as Error).message });
              continue;
            }
          }
          let failed: string | null = null;
          if (r.productCode) {
            if (!productKey) failed = "productCode verildi ama productKey yok";
            else {
              const t = await translate(productKey, r.productCode);
              if (t.ok) setContextValue(ctx, productKey.Id, t.value);
              else failed = t.detail;
            }
          }
          if (!failed && r.vehicleCode) {
            if (!vehicleKey) failed = "vehicleCode verildi ama vehicleKey yok";
            else {
              const t = await translate(vehicleKey, r.vehicleCode);
              if (t.ok) setContextValue(ctx, vehicleKey.Id, t.value);
              else failed = t.detail;
            }
          }
          if (failed) {
            findings.push({ ...base, key: `${key.Id} ${key.KeyName}`, result: "KOD_YOK", detail: failed });
            continue;
          }

          const sig = JSON.stringify([key.Id, productIds ? [...productIds].sort() : null, describeContext(ctx)]);
          if (!groups.has(sig)) {
            groups.set(sig, {
              label: sig,
              key,
              parameterId: Number(key.ParameterId),
              ctx,
              productIds,
              codes: new Set(),
              rowLabel: { statCode: r.statCode ?? "", product: base.product, vehicle: base.vehicle },
            });
          }
          const g = groups.get(sig)!;
          g.codes.add(r.valueCode.trim());
          findings.push({ ...base, key: `${key.Id} ${key.KeyName}`, _group: sig });
        }

        // Evaluate every group once.
        const evaluatedGroups = new Map<string, { set: Parameters<typeof classifyBulkRow>[1]; group: Group }>();
        for (const [sig, g] of groups) {
          const p = await getParam(g.parameterId);
          const own = p.values.flatMap((v) =>
            v.crosses.filter((c) => Number(c.InsuranceCompanyId) === company.id && crossAppliesToProducts(c, g.productIds))
          );
          const missing = own.filter((c) => !depCache.has(c.ParameterValueCrossedId));
          for (const [id, d] of await loadDependencies(panel, missing, refresh)) depCache.set(id, d);
          const byValue = new Map<string, EvaluatedCross[]>();
          const valueText = new Map<string, string>();
          for (const v of p.values) {
            valueText.set(v.value.Value, v.value.Text);
            const list = v.crosses
              .filter((c) => Number(c.InsuranceCompanyId) === company.id && crossAppliesToProducts(c, g.productIds))
              .map((c) => {
                const d = depCache.get(c.ParameterValueCrossedId) ?? [];
                return { cross: c, deps: d, result: evaluateDependencies(d, g.ctx) };
              });
            if (list.length) byValue.set(v.value.Value, list);
          }
          evaluatedGroups.set(sig, { set: { byValue, valueText }, group: g });
        }

        for (const f of findings) {
          if (!f._group) continue;
          const { set } = evaluatedGroups.get(f._group as string)!;
          const res = classifyBulkRow(String(f.valueCode), set);
          f.result = res.result;
          f.detail = res.detail;
          f.crossIds = res.crossIds.join(",");
          f.igwValue = res.parameterValues.map((v) => `${v} ${set.valueText.get(v) ?? ""}`.trim()).join(", ");
          delete f._group;
        }

        if (args.includeExtras !== false) {
          for (const { set, group } of evaluatedGroups.values()) {
            for (const x of bulkExtras(group.codes, set)) {
              findings.push({
                ...group.rowLabel,
                key: `${group.key.Id} ${group.key.KeyName}`,
                valueCode: x.cross.CrossValue,
                result: x.result,
                detail: x.detail,
                crossIds: String(x.cross.ParameterValueCrossedId),
                igwValue: `${x.originalValue} ${set.valueText.get(x.originalValue) ?? ""}`.trim(),
              });
            }
            for (const [v, crosses] of set.byValue) {
              const eff = effectiveForValue(v, crosses);
              const w = eff.effective && isZeroValue(eff.effective.cross) ? iupZeroWarning(eff.effective.cross, eff.effective.deps) : null;
              if (w && group.ctx.genericIupAgent) {
                findings.push({
                  ...group.rowLabel,
                  key: `${group.key.Id} ${group.key.KeyName}`,
                  valueCode: "0",
                  result: "UYARI_0",
                  detail: w,
                  crossIds: String(eff.effective!.cross.ParameterValueCrossedId),
                  igwValue: `${v} ${set.valueText.get(v) ?? ""}`.trim(),
                });
              }
            }
          }
        }

        const columns = ["result", "statCode", "key", "product", "vehicle", "valueCode", "igwValue", "crossIds", "detail"];
        const header = ["Sonuç", "İstatistik Kodu", "Key", "Ürün", "Araç", "Değer Kodu", "IGW Değeri", "Cross Id", "Açıklama"];
        const clean = (v: unknown) => String(v ?? "").replace(/[\t\n\r]+/g, " ");
        const tsvLines = [header.join("\t"), ...findings.map((f) => columns.map((c) => clean(f[c])).join("\t"))];
        const summary: Record<string, number> = {};
        for (const f of findings) summary[String(f.result)] = (summary[String(f.result)] ?? 0) + 1;

        // Keep the full TSV when it fits; otherwise fit the JSON findings and cut the TSV.
        const meta = {
          company: `${company.id} ${company.name}`,
          context: args.agentId == null ? "700 altındaki IUP acentesi (varsayılan)" : `Acente ${args.agentId}`,
          inputRows: args.rows.length,
          summary,
          note: NOTE_RULES + " FAZLA/FAZLA_ACIK satırları tablodaki aynı key + ürün + araç bağlamı için üretilir.",
        };
        let tsv = tsvLines.join("\n");
        const budget = 14000;
        if (tsv.length > budget) {
          const kept: string[] = [];
          let size = 0;
          for (const line of tsvLines) {
            if (size + line.length + 1 > budget) break;
            kept.push(line);
            size += line.length + 1;
          }
          tsv = kept.join("\n") + `\n… TSV kesildi: ${tsvLines.length - kept.length} satır daha var (satırları bölerek tekrar çalıştırın)`;
        }
        const nonOk = findings.filter((f) => f.result !== "OK");
        return textResult(serializeFitting({ ...meta, tsv }, "findings", nonOk));
      } catch (error) {
        return fail(error);
      }
    }
  );
}

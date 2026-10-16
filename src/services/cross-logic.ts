import { PanelCross, PanelCrossDependency } from "../types.js";

/**
 * Pure (network-free) rules for the Parameter → Value → Cross → Dependency
 * tools, kept separate from the MCP wiring so they can be unit-tested.
 *
 * Business rules (from the InsurUp spec):
 * - CrossValue is what actually goes to the company; "0" means the value
 *   does not work in that company/product/agent context.
 * - ProductId -1 ("Tanımsız") applies to every product of the company.
 * - InsurUp agents sit under InsurUp Parent (700); a cross whose
 *   dependencies require Parent ID ≠ 700 is closed to IUP.
 * - A "0" on a cross that IUP agents can reach must be raised as a warning.
 */

export const PRODUCT_ALL = -1;
export const IUP_PARENT_ID = 700;
export const KEY_AGENT_ID = "Acente ID";
export const KEY_PARENT_ID = "Parent ID";

export const SPECIAL_AGENTS: Record<number, string> = {
  700: "InsurUp Parent",
  [-999]: "SigortaPro Parent",
  [-900]: "BrokerPro Parent",
  0: "All Agents",
};

/** Agent type codes as the panel's cross search dropdown labels them. */
export const AGENT_TYPE_NAMES: Record<number, string> = {
  0: "Tanımsız",
  1: "Acente",
  2: "Broker",
  3: "Banka",
  4: "Sigorta Şirketi",
};

export const OP_TEXT: Record<string, string> = {
  "=": "=",
  "!=": "≠",
  ">": ">",
  "<": "<",
  "[==]": "barındırıyor",
  "[!=]": "barındırmıyor",
};

export const tr = (v: unknown): string =>
  String(v ?? "")
    .trim()
    .toLocaleLowerCase("tr-TR");

export const isZeroValue = (c: Pick<PanelCross, "CrossValue">): boolean =>
  String(c.CrossValue ?? "").trim() === "0";

export const isAllProducts = (c: Pick<PanelCross, "ProductId">): boolean =>
  Number(c.ProductId) === PRODUCT_ALL;

/** A cross is "generic" when it is open to every product or has no conditions. */
export const isGenericCross = (c: Pick<PanelCross, "ProductId" | "Dependent">): boolean =>
  isAllProducts(c) || !c.Dependent;

/**
 * Whether a cross applies to the requested products. `productIds = null`
 * means no product filter. ProductId -1 always applies (it covers every
 * product of the company).
 */
export function crossAppliesToProducts(
  c: Pick<PanelCross, "ProductId">,
  productIds: ReadonlySet<number> | null
): boolean {
  if (!productIds) return true;
  if (isAllProducts(c)) return true;
  return productIds.has(Number(c.ProductId));
}

// ── Evaluation context ──────────────────────────────────────────────

export interface EvaluationContext {
  /** Values by key Id (preferred when a dependency row carries the Id). */
  byId: Map<number, string>;
  /** Values by normalised key name. */
  byName: Map<string, string>;
  /** Original spelling of each key name, for output. */
  labels: Map<string, string>;
  /**
   * True when no concrete agent was given and the context stands for "an
   * InsurUp agent under Parent 700". Acente ID conditions are then decided
   * as: `= X` fails unless X is 0 (all agents), `≠ X` passes.
   */
  genericIupAgent: boolean;
}

export function emptyContext(): EvaluationContext {
  return { byId: new Map(), byName: new Map(), labels: new Map(), genericIupAgent: false };
}

/** Set a context value by key name or numeric key Id. */
export function setContextValue(ctx: EvaluationContext, key: string | number, value: string): void {
  const k = String(key).trim();
  if (/^\d+$/.test(k)) ctx.byId.set(Number(k), String(value).trim());
  else {
    ctx.byName.set(tr(k), String(value).trim());
    ctx.labels.set(tr(k), k);
  }
}

/** Plain-object view of a context for tool output. */
export function describeContext(ctx: EvaluationContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.genericIupAgent && !ctx.byName.has(tr(KEY_AGENT_ID))) {
    out[KEY_AGENT_ID] = "(belirtilmedi: 700 altındaki herhangi bir IUP acentesi)";
  }
  for (const [k, v] of ctx.byName) out[ctx.labels.get(k) ?? k] = v;
  for (const [k, v] of ctx.byId) out[`Key ${k}`] = v;
  return out;
}

export interface AgentRow {
  Id: number;
  ParentId: number | null;
  AgentName: string;
  ParentAgentName?: string | null;
  AgentType?: number;
  Status?: boolean;
}

/** Ancestors of an agent, nearest first (guards against cycles). */
export function agentChain(agents: ReadonlyMap<number, AgentRow>, agentId: number): AgentRow[] {
  const chain: AgentRow[] = [];
  const seen = new Set<number>([agentId]);
  let cursor = agents.get(agentId);
  while (cursor && cursor.ParentId != null) {
    const parentId = Number(cursor.ParentId);
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = agents.get(parentId);
    if (!parent) {
      if (SPECIAL_AGENTS[parentId] !== undefined && parentId !== 0) {
        chain.push({ Id: parentId, ParentId: 0, AgentName: SPECIAL_AGENTS[parentId] });
      }
      break;
    }
    chain.push(parent);
    cursor = parent;
  }
  return chain;
}

/**
 * Build the agent part of an evaluation context. With an agent: Acente ID
 * and Parent ID (its direct parent, which is what the panel's Parent ID key
 * holds) plus the full ancestor chain as notes. Without one: the spec's
 * default, a generic InsurUp agent under Parent 700.
 */
export function agentContext(
  agents: ReadonlyMap<number, AgentRow>,
  agentId: number | undefined
): { ctx: EvaluationContext; notes: string[]; chain: string[] } {
  const ctx = emptyContext();
  const notes: string[] = [];
  if (agentId == null) {
    ctx.genericIupAgent = true;
    setContextValue(ctx, KEY_PARENT_ID, String(IUP_PARENT_ID));
    notes.push(
      "Acente verilmedi: varsayılan bağlam InsurUp Parent (700) altındaki bir IUP acentesidir (Parent ID = 700)."
    );
    return { ctx, notes, chain: [`${IUP_PARENT_ID} InsurUp Parent`] };
  }
  setContextValue(ctx, KEY_AGENT_ID, String(agentId));
  const self = agents.get(agentId);
  if (!self) {
    notes.push(`${agentId} kodlu acente panelin acente listesinde yok; Parent ID bilinmiyor.`);
    return { ctx, notes, chain: [] };
  }
  if (self.ParentId == null) {
    notes.push(`${agentId} ${self.AgentName} için üst acente tanımlı değil; Parent ID koşulları bu acente için değerlendirilemez.`);
  } else {
    setContextValue(ctx, KEY_PARENT_ID, String(self.ParentId));
  }
  const children = [...agents.values()].filter((a) => Number(a.ParentId) === agentId && a.ParentId != null);
  if (children.length) {
    notes.push(
      `${agentId} ${self.AgentName} aynı zamanda ${children.length} acentenin üstü; 'Parent ID = ${agentId}' koşulları bu alt acenteler için geçerlidir (agentId olarak alt acenteyi verin).`
    );
  }
  const chain = agentChain(agents, agentId).map(
    (a) => `${a.Id} ${a.AgentName}${a.Status === false ? " (pasif)" : ""}`
  );
  if (self.Status === false) notes.push(`${agentId} ${self.AgentName} pasif bir acente.`);
  const underIup = agentChain(agents, agentId).some((a) => Number(a.Id) === IUP_PARENT_ID);
  if (underIup && Number(self.ParentId) !== IUP_PARENT_ID) {
    notes.push(
      `Acente 700 altında ama doğrudan üstü ${self.ParentId}; Parent ID koşulları doğrudan üst acenteyle karşılaştırıldı.`
    );
  }
  return { ctx, notes, chain };
}

/**
 * Parse "Key=Value" lines (key by name or numeric Id). Returns the lines
 * it could not parse so tools can echo them back.
 */
export function applyContextLines(ctx: EvaluationContext, lines: readonly string[]): string[] {
  const bad: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      bad.push(line);
      continue;
    }
    setContextValue(ctx, line.slice(0, eq), line.slice(eq + 1));
  }
  return bad;
}

// ── Dependency evaluation ──────────────────────────────────────────

export type Verdict = "pass" | "fail" | "unknown";

type DepRow = Pick<
  PanelCrossDependency,
  | "DependentKeyId"
  | "DependentKeyName"
  | "DependentKeyValue"
  | "DependencyType"
  | "DependencyGroupNo"
  | "DependencyGroupConnectionTypeToOtherGroup"
  | "DependencyConnectionTypeToOtherKey"
>;

function lookup(ctx: EvaluationContext, dep: DepRow): string | undefined {
  return ctx.byId.get(Number(dep.DependentKeyId)) ?? ctx.byName.get(tr(dep.DependentKeyName));
}

export function evaluateDependencyRow(dep: DepRow, ctx: EvaluationContext): Verdict {
  const rhs = String(dep.DependentKeyValue ?? "").trim();
  const isAgentKey = tr(dep.DependentKeyName) === tr(KEY_AGENT_ID);
  const value = lookup(ctx, dep);

  if (isAgentKey && rhs === "0") {
    // Acente ID 0 = All Agents
    if (dep.DependencyType === "=") return "pass";
    if (dep.DependencyType === "!=") return "fail";
  }
  if (value === undefined) {
    if (isAgentKey && ctx.genericIupAgent) {
      if (dep.DependencyType === "=") return "fail";
      if (dep.DependencyType === "!=") return "pass";
    }
    return "unknown";
  }
  const lhs = value.trim();
  switch (dep.DependencyType) {
    case "=":
      return lhs === rhs ? "pass" : "fail";
    case "!=":
      return lhs !== rhs ? "pass" : "fail";
    case ">":
    case "<": {
      const a = Number(lhs.replace(",", "."));
      const b = Number(rhs.replace(",", "."));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return "unknown";
      return (dep.DependencyType === ">" ? a > b : a < b) ? "pass" : "fail";
    }
    case "[==]":
      return lhs.includes(rhs) ? "pass" : "fail";
    case "[!=]":
      return lhs.includes(rhs) ? "fail" : "pass";
    default:
      return "unknown";
  }
}

function combine(a: Verdict, b: Verdict, op: "&&" | "||"): Verdict {
  if (op === "||") {
    if (a === "pass" || b === "pass") return "pass";
    if (a === "unknown" || b === "unknown") return "unknown";
    return "fail";
  }
  if (a === "fail" || b === "fail") return "fail";
  if (a === "unknown" || b === "unknown") return "unknown";
  return "pass";
}

const connector = (v: string | null | undefined): "&&" | "||" =>
  String(v ?? "").trim() === "||" ? "||" : "&&";

/** Dependency rows grouped by group number, in group order. */
export function groupDependencies<T extends DepRow>(deps: readonly T[]): Array<{ groupNo: string; rows: T[] }> {
  const byGroup = new Map<string, T[]>();
  for (const d of deps) {
    const g = d.DependencyGroupNo == null ? "-" : String(d.DependencyGroupNo);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(d);
  }
  return [...byGroup.entries()]
    .sort((a, b) => {
      if (a[0] === "-") return 1;
      if (b[0] === "-") return -1;
      return Number(a[0]) - Number(b[0]);
    })
    .map(([groupNo, rows]) => ({ groupNo, rows }));
}

/** How a group connects to the next one: the first non-empty marker in the group. */
function groupConnector(rows: readonly DepRow[]): "&&" | "||" {
  const marked = [...rows]
    .reverse()
    .find((r) => String(r.DependencyGroupConnectionTypeToOtherGroup ?? "").trim() !== "");
  return connector(marked?.DependencyGroupConnectionTypeToOtherGroup);
}

export interface DependencyVerdict<T extends DepRow = DepRow> {
  verdict: Verdict;
  groups: Array<{ groupNo: string; verdict: Verdict; rows: Array<{ dep: T; verdict: Verdict }> }>;
}

/**
 * Evaluate a cross's dependency rows. Inside a group each row connects to
 * the next with its own DependencyConnectionTypeToOtherKey; groups connect
 * with DependencyGroupConnectionTypeToOtherGroup. Missing connectors default
 * to &&. A cross without dependency rows passes.
 */
export function evaluateDependencies<T extends DepRow>(
  deps: readonly T[],
  ctx: EvaluationContext
): DependencyVerdict<T> {
  const groups = groupDependencies(deps).map(({ groupNo, rows }) => {
    const evaluated = rows.map((dep) => ({ dep, verdict: evaluateDependencyRow(dep, ctx) }));
    let acc = evaluated[0].verdict;
    for (let i = 1; i < evaluated.length; i++) {
      acc = combine(acc, evaluated[i].verdict, connector(evaluated[i - 1].dep.DependencyConnectionTypeToOtherKey));
    }
    return { groupNo, verdict: acc, rows: evaluated };
  });
  let verdict: Verdict = groups[0]?.verdict ?? "pass";
  for (let i = 1; i < groups.length; i++) {
    verdict = combine(verdict, groups[i].verdict, groupConnector(groups[i - 1].rows.map((r) => r.dep)));
  }
  return { verdict, groups };
}

/** Readable reasons for a failed or undecided evaluation. */
export function explainVerdict<T extends DepRow>(
  result: DependencyVerdict<T>,
  agents?: ReadonlyMap<number, AgentRow>
): string {
  if (result.verdict === "unknown") {
    const missing = [
      ...new Set(
        result.groups.flatMap((g) =>
          g.rows.filter((r) => r.verdict === "unknown").map((r) => `${r.dep.DependentKeyName} (Key ${r.dep.DependentKeyId})`)
        )
      ),
    ];
    return `bağlamda eksik koşul: ${missing.join(", ")}`;
  }
  const failed = result.groups
    .filter((g) => g.verdict === "fail")
    .map((g) => {
      const label = g.groupNo === "-" ? "" : `grup ${g.groupNo}: `;
      return label + renderGroup(g.rows.map((r) => r.dep), agents);
    });
  return `sağlanmayan koşul: ${failed.join(" | ")}`;
}

// ── Readable rendering ─────────────────────────────────────────────

function agentLabel(id: string, agents?: ReadonlyMap<number, AgentRow>): string {
  const n = Number(id);
  if (!/^-?\d+$/.test(id.trim())) return id;
  const a = agents?.get(n);
  if (a) return `${id} (${a.AgentName}${a.Status === false ? " – pasif" : ""})`;
  if (SPECIAL_AGENTS[n] !== undefined) return `${id} (${SPECIAL_AGENTS[n]})`;
  return id;
}

function valueLabel(dep: DepRow, value: string, agents?: ReadonlyMap<number, AgentRow>): string {
  const key = tr(dep.DependentKeyName);
  if (key === tr(KEY_AGENT_ID) || key === tr(KEY_PARENT_ID)) return agentLabel(value, agents);
  return value;
}

function renderGroup(rows: readonly DepRow[], agents?: ReadonlyMap<number, AgentRow>): string {
  // Merge runs like "Acente ID = 11588 || Acente ID = 11723" into
  // "Acente ID = 11588 (VDF) VEYA 11723 (VDF PREP – pasif)".
  const parts: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const head = rows[i];
    const values = [valueLabel(head, String(head.DependentKeyValue ?? ""), agents)];
    let j = i;
    while (
      j + 1 < rows.length &&
      connector(rows[j].DependencyConnectionTypeToOtherKey) === "||" &&
      Number(rows[j + 1].DependentKeyId) === Number(head.DependentKeyId) &&
      rows[j + 1].DependencyType === head.DependencyType
    ) {
      j++;
      values.push(valueLabel(rows[j], String(rows[j].DependentKeyValue ?? ""), agents));
    }
    let text = `${head.DependentKeyName} ${OP_TEXT[head.DependencyType] ?? head.DependencyType} ${values.join(" VEYA ")}`;
    if (
      tr(head.DependentKeyName) === tr(KEY_PARENT_ID) &&
      head.DependencyType === "!=" &&
      String(head.DependentKeyValue).trim() === String(IUP_PARENT_ID)
    ) {
      text += " → IUP'a kapalı";
    }
    parts.push(text);
    if (j + 1 < rows.length) parts.push(connector(rows[j].DependencyConnectionTypeToOtherKey) === "||" ? "VEYA" : "VE");
    i = j + 1;
  }
  return parts.join(" ");
}

/**
 * The whole dependency set as one readable expression, e.g.
 * "grup 0: Acente ID = 11588 (VDF) VEYA 11723 (VDF PREP – pasif) VE grup 1: Araç Kullanım Şekli = 01 VEYA 06".
 */
export function renderDependencies(
  deps: readonly DepRow[],
  agents?: ReadonlyMap<number, AgentRow>
): string {
  if (!deps.length) return "koşulsuz (bağımsız tanım)";
  const groups = groupDependencies(deps);
  const multi = groups.length > 1;
  let out = "";
  groups.forEach((g, i) => {
    if (i > 0) out += groupConnector(groups[i - 1].rows) === "||" ? " VEYA " : " VE ";
    const body = renderGroup(g.rows, agents);
    out += multi && g.groupNo !== "-" ? `(grup ${g.groupNo}: ${body})` : body;
  });
  return out;
}

/** True when the dependency set contains "Parent ID ≠ 700" (closed to IUP). */
export function closedToIup(deps: readonly DepRow[]): boolean {
  return deps.some(
    (d) =>
      tr(d.DependentKeyName) === tr(KEY_PARENT_ID) &&
      d.DependencyType === "!=" &&
      String(d.DependentKeyValue).trim() === String(IUP_PARENT_ID)
  );
}

/** Context for "any InsurUp agent": Parent ID = 700, no concrete Acente ID. */
export function iupContext(): EvaluationContext {
  const ctx = emptyContext();
  ctx.genericIupAgent = true;
  setContextValue(ctx, KEY_PARENT_ID, String(IUP_PARENT_ID));
  return ctx;
}

/**
 * Whether IUP agents can reach a cross: dependencies do not fail for a
 * generic agent under Parent 700. "unknown" (conditions on other keys such
 * as vehicle use) still counts as reachable — some IUP request can meet them.
 */
export function reachableByIup(deps: readonly DepRow[]): boolean {
  return evaluateDependencies(deps, iupContext()).verdict !== "fail";
}

/** Spec warning: a "0" on a cross IUP agents can reach. */
export function iupZeroWarning(
  cross: Pick<PanelCross, "CrossValue">,
  deps: readonly DepRow[]
): string | null {
  if (!isZeroValue(cross)) return null;
  if (!reachableByIup(deps)) return null;
  return "UYARI: IUP acentelerine (Parent 700) açık bir cross'ta Cross Değeri 0 (değer IUP'ta çalışmaz)";
}

// ── Effective cross per parameter value ────────────────────────────

/**
 * Rank used when several crosses of one parameter value pass in the same
 * context. The panel's list does not return Bağımlılık Sırası, so this is an
 * approximation: product-specific before "Tüm ürünler", conditional before
 * unconditional.
 */
export function precedenceRank(c: Pick<PanelCross, "ProductId" | "Dependent">): number {
  return (isAllProducts(c) ? 2 : 0) + (c.Dependent ? 0 : 1);
}

export interface EvaluatedCross {
  cross: PanelCross;
  deps: PanelCrossDependency[];
  result: DependencyVerdict<PanelCrossDependency>;
}

export interface EffectiveValue {
  originalValue: string;
  /** "GECERLI" a non-zero value goes; "DESTEKLENMIYOR" the winner is 0; "TANIM_YOK" nothing passes; "BELIRSIZ" only undecided crosses. */
  status: "GECERLI" | "DESTEKLENMIYOR" | "TANIM_YOK" | "BELIRSIZ";
  effective: EvaluatedCross | null;
  /** True when several crosses tie at the top rank with different values. */
  ambiguous: boolean;
  passing: EvaluatedCross[];
  failing: EvaluatedCross[];
  unknown: EvaluatedCross[];
}

export function effectiveForValue(originalValue: string, crosses: readonly EvaluatedCross[]): EffectiveValue {
  const passing = crosses.filter((c) => c.result.verdict === "pass");
  const failing = crosses.filter((c) => c.result.verdict === "fail");
  const unknown = crosses.filter((c) => c.result.verdict === "unknown");
  const sorted = [...passing].sort((a, b) => precedenceRank(a.cross) - precedenceRank(b.cross));
  const effective = sorted[0] ?? null;
  const ambiguous =
    effective != null &&
    sorted.some(
      (c) =>
        precedenceRank(c.cross) === precedenceRank(effective.cross) &&
        String(c.cross.CrossValue).trim() !== String(effective.cross.CrossValue).trim()
    );
  let status: EffectiveValue["status"];
  if (effective) status = isZeroValue(effective.cross) ? "DESTEKLENMIYOR" : "GECERLI";
  else if (unknown.length) status = "BELIRSIZ";
  else status = "TANIM_YOK";
  return { originalValue, status, effective, ambiguous, passing, failing, unknown };
}

/** "Ürün Tanımsız (-1), koşulsuz tanım" / "ürüne özel, koşullu tanım" … */
export function scopeText(c: Pick<PanelCross, "ProductId" | "Dependent">): string {
  return `${isAllProducts(c) ? "Ürün Tanımsız (-1)" : "ürüne özel"}, ${c.Dependent ? "koşullu" : "koşulsuz"} tanım`;
}

// ── Bulk check classification ──────────────────────────────────────

export interface BulkValueSet {
  /** Parameter value → crosses of the company that apply to the row's product, already evaluated. */
  byValue: Map<string, EvaluatedCross[]>;
  /** Text label per parameter value. */
  valueText: Map<string, string>;
}

export interface BulkRowResult {
  result: "OK" | "EKSIK" | "BELIRSIZ";
  detail: string;
  crossIds: number[];
  parameterValues: string[];
}

/** Classify one company-table row (its value code) against IGW definitions. */
export function classifyBulkRow(valueCode: string, set: BulkValueSet): BulkRowResult {
  const code = valueCode.trim();
  const eff = [...set.byValue.entries()].map(([v, crosses]) => effectiveForValue(v, crosses));

  const ok = eff.filter((e) => e.effective && String(e.effective.cross.CrossValue).trim() === code);
  if (ok.length) {
    const scopes = [...new Set(ok.map((e) => scopeText(e.effective!.cross)))];
    return {
      result: "OK",
      detail:
        ok.map((e) => set.valueText.get(e.originalValue) ?? e.originalValue).join(", ") +
        ` — ${scopes.join("; ")}` +
        (ok.some((e) => e.ambiguous) ? " — eşit öncelikli farklı tanımlar var" : ""),
      crossIds: ok.map((e) => e.effective!.cross.ParameterValueCrossedId),
      parameterValues: ok.map((e) => e.originalValue),
    };
  }

  const overridden = eff.filter(
    (e) => e.effective && e.passing.some((p) => String(p.cross.CrossValue).trim() === code)
  );
  if (overridden.length) {
    const e = overridden[0];
    const sent = String(e.effective!.cross.CrossValue).trim();
    return {
      result: "EKSIK",
      detail: `${set.valueText.get(e.originalValue) ?? e.originalValue}: bu bağlamda daha öncelikli tanım ${
        sent === "0" ? "0 (desteklenmiyor)" : sent
      } gönderiyor`,
      crossIds: [e.effective!.cross.ParameterValueCrossedId],
      parameterValues: [e.originalValue],
    };
  }

  const withCode = eff.flatMap((e) =>
    [...e.failing, ...e.unknown]
      .filter((c) => String(c.cross.CrossValue).trim() === code)
      .map((c) => ({ e, c }))
  );
  const undecided = withCode.filter((x) => x.c.result.verdict === "unknown");
  if (undecided.length && undecided.length === withCode.length) {
    return {
      result: "BELIRSIZ",
      detail: explainVerdict(undecided[0].c.result),
      crossIds: undecided.map((x) => x.c.cross.ParameterValueCrossedId),
      parameterValues: [...new Set(undecided.map((x) => x.e.originalValue))],
    };
  }
  if (withCode.length) {
    const x = withCode.find((y) => y.c.result.verdict === "fail") ?? withCode[0];
    return {
      result: "EKSIK",
      detail: `tanım var ama bu bağlamda elendi (${explainVerdict(x.c.result)})`,
      crossIds: withCode.map((y) => y.c.cross.ParameterValueCrossedId),
      parameterValues: [...new Set(withCode.map((y) => y.e.originalValue))],
    };
  }
  return {
    result: "EKSIK",
    detail: "IGW'de bu şirket/ürün için bu değer koduna giden cross yok",
    crossIds: [],
    parameterValues: [],
  };
}

export interface BulkExtra {
  result: "FAZLA" | "FAZLA_ACIK";
  originalValue: string;
  cross: PanelCross;
  detail: string;
}

/**
 * Definitions IGW sends in this context whose code the company table does
 * not list. FAZLA_ACIK when the cross is generic (Ürün -1 or unconditional),
 * i.e. it is open wider than the company's own table.
 */
export function bulkExtras(tableCodes: ReadonlySet<string>, set: BulkValueSet): BulkExtra[] {
  const out: BulkExtra[] = [];
  for (const [v, crosses] of set.byValue) {
    const e = effectiveForValue(v, crosses);
    if (e.status !== "GECERLI" || !e.effective) continue;
    const c = e.effective.cross;
    if (tableCodes.has(String(c.CrossValue).trim())) continue;
    const generic = isGenericCross(c);
    out.push({
      result: generic ? "FAZLA_ACIK" : "FAZLA",
      originalValue: v,
      cross: c,
      detail: `şirket tablosunda yok; ${scopeText(c)}${generic ? " olduğu için bu bağlamda da açık" : ""}`,
    });
  }
  return out;
}

/** Translate a company code to IGW parameter value(s) through the company's crosses. */
export function translateCompanyCode(
  code: string,
  crossesByValue: ReadonlyMap<string, readonly PanelCross[]>
): string[] {
  const target = code.trim();
  const hits: string[] = [];
  for (const [value, crosses] of crossesByValue) {
    if (crosses.some((c) => String(c.CrossValue).trim() === target && !isZeroValue(c))) hits.push(value);
  }
  return hits;
}

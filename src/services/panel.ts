import axios, { AxiosResponse } from "axios";
import {
  PanelConfig,
  PanelProduct,
  PanelKey,
  PanelParameter,
  PanelParameterValue,
  PanelCross,
  PanelCrossDependency,
  PanelKeyDependency,
} from "../types.js";
import { PRODUCTS_CACHE_TTL_MS } from "../constants.js";

interface RowsCache<T> {
  data: T[];
  fetchedAt: number;
}

/**
 * Client for the GatewayProUI admin panel (panel.insurapps.net).
 * Uses classic ASP.NET cookie auth: GET login page for the antiforgery
 * token, POST the form, keep session cookies for subsequent requests.
 *
 * Every DataTables-backed list endpoint (/Product/GetProducts,
 * /Key/GetKeys, /Parameter/GetParameters) 500s when sent per-column
 * search params, so we fetch the full list in one request and filter
 * locally. Results are cached per-endpoint for a short TTL.
 */
export class PanelClient {
  private cookies = new Map<string, string>();
  private loginPromise: Promise<void> | null = null;
  private caches = new Map<string, RowsCache<unknown>>();

  constructor(private readonly config: PanelConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  private collectCookies(res: AxiosResponse): void {
    const setCookies = res.headers["set-cookie"];
    if (!setCookies) return;
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async login(): Promise<void> {
    // Mutex via shared promise — avoid parallel logins
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async doLogin(): Promise<void> {
    this.cookies.clear();

    const loginPage = await axios.get(`${this.baseUrl}/Account/LogIn`, {
      maxRedirects: 0,
      validateStatus: () => true,
    });
    this.collectCookies(loginPage);

    const tokenMatch =
      /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(
        String(loginPage.data)
      );
    if (!tokenMatch) {
      throw new Error(
        "Panel login failed — antiforgery token not found on login page"
      );
    }

    const form = new URLSearchParams({
      EmailOrUserName: this.config.username,
      Password: this.config.password,
      RememberMe: "false",
      __RequestVerificationToken: tokenMatch[1],
    });

    const res = await axios.post(
      `${this.baseUrl}/Account/Login?returnurl=%2F`,
      form.toString(),
      {
        headers: {
          Cookie: this.cookieHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        maxRedirects: 0,
        validateStatus: () => true,
      }
    );
    this.collectCookies(res);

    // Successful login redirects (302); 200 means the form re-rendered with errors
    if (res.status !== 302) {
      throw new Error(
        `Panel login failed (HTTP ${res.status}) — check IGW_PANEL_USERNAME / IGW_PANEL_PASSWORD`
      );
    }
  }

  private async fetchRowsRaw<T>(
    path: string,
    start = 0,
    length = 100000
  ): Promise<{ data: T[]; recordsTotal: number } | null> {
    return this.postRowsRaw<T>(path, `draw=1&start=${start}&length=${length}`);
  }

  /**
   * Generic DataTables POST with an arbitrary form body. The panel's
   * endpoints bind their filters from the form, so field names must match
   * the server model. Notably /ParameterValueCrossed/GetParameterValueCrosses
   * returns 0 rows unless both ParameterId and ParameterValue (the cross's
   * original value) bind — omitting them silently yields an empty list.
   */
  private async postRowsRaw<T>(
    path: string,
    form: string
  ): Promise<{ data: T[]; recordsTotal: number } | null> {
    const res = await axios.post(`${this.baseUrl}/${path}`, form, {
      headers: {
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      maxRedirects: 0,
      validateStatus: () => true,
    });
    this.collectCookies(res);

    const body = res.data as { data?: T[]; recordsTotal?: number } | string;
    if (res.status === 200 && typeof body === "object" && Array.isArray(body?.data)) {
      return { data: body.data, recordsTotal: body.recordsTotal ?? body.data.length };
    }
    // 401 / redirect to login / HTML page → session invalid
    return null;
  }

  /** POST a DataTables list with a custom form body, logging in on stale session, cached ~10 min. */
  private async postRows<T>(
    path: string,
    form: Record<string, string>,
    refresh = false
  ): Promise<T[]> {
    const formKey = `${path}?${new URLSearchParams(form).toString()}`;

    const cached = this.caches.get(formKey);
    if (
      !refresh &&
      cached &&
      Date.now() - cached.fetchedAt < PRODUCTS_CACHE_TTL_MS
    ) {
      return cached.data as T[];
    }

    const body = new URLSearchParams(form).toString();

    let result =
      this.cookies.size > 0 ? await this.postRowsRaw<T>(path, body) : null;
    if (!result) {
      await this.login();
      result = await this.postRowsRaw<T>(path, body);
    }
    if (!result) {
      throw new Error(
        `Panel request for ${path} failed after login — panel may be down or the account lacks access`
      );
    }

    this.caches.set(formKey, { data: result.data, fetchedAt: Date.now() });
    return result.data;
  }

  /**
   * Fetch a full DataTables list (all rows in one request), logging in
   * and retrying once if the session is stale. Cached per endpoint for a
   * short TTL. Only safe for endpoints small enough to return fully —
   * huge tables (users, agent connections, action logs) must use
   * {@link fetchPage} instead.
   */
  async fetchAll<T>(path: string, refresh = false): Promise<T[]> {
    const cached = this.caches.get(path);
    if (
      !refresh &&
      cached &&
      Date.now() - cached.fetchedAt < PRODUCTS_CACHE_TTL_MS
    ) {
      return cached.data as T[];
    }

    let result = this.cookies.size > 0 ? await this.fetchRowsRaw<T>(path) : null;
    if (!result) {
      await this.login();
      result = await this.fetchRowsRaw<T>(path);
    }
    if (!result) {
      throw new Error(
        `Panel request for ${path} failed after login — panel may be down or the account lacks access`
      );
    }

    this.caches.set(path, { data: result.data, fetchedAt: Date.now() });
    return result.data;
  }

  /**
   * Fetch a single server-side page from a DataTables endpoint. Used for
   * tables too large to pull in full. Not cached. Returns the page rows
   * plus the server's total record count.
   */
  async fetchPage<T>(
    path: string,
    start: number,
    length: number
  ): Promise<{ rows: T[]; total: number }> {
    let result =
      this.cookies.size > 0 ? await this.fetchRowsRaw<T>(path, start, length) : null;
    if (!result) {
      await this.login();
      result = await this.fetchRowsRaw<T>(path, start, length);
    }
    if (!result) {
      throw new Error(
        `Panel page request for ${path} failed after login — panel may be down or the account lacks access`
      );
    }
    return { rows: result.data, total: result.recordsTotal };
  }

  /** Full product catalog from /Product/GetProducts. */
  getAllProducts(refresh = false): Promise<PanelProduct[]> {
    return this.fetchAll<PanelProduct>("Product/GetProducts", refresh);
  }

  /** Full key catalog from /Key/GetKeys. */
  getAllKeys(refresh = false): Promise<PanelKey[]> {
    return this.fetchAll<PanelKey>("Key/GetKeys", refresh);
  }

  /** Full parameter catalog from /Parameter/GetParameters. */
  getAllParameters(refresh = false): Promise<PanelParameter[]> {
    return this.fetchAll<PanelParameter>("Parameter/GetParameters", refresh);
  }

  /**
   * All parameter values (Parameter Value screen) for one parameter, from
   * /ParameterValue/GetParameterValues?parameterId=….
   */
  getParameterValues(parameterId: number, refresh = false): Promise<PanelParameterValue[]> {
    return this.postRows<PanelParameterValue>(
      "ParameterValue/GetParameterValues",
      { draw: "1", start: "0", length: "100000", parameterId: String(parameterId) },
      refresh
    );
  }

  /**
   * All crosses for one parameter value, from
   * /ParameterValueCrossed/GetParameterValueCrosses. The endpoint silently
   * returns an empty list unless BOTH ParameterId and ParameterValue (the
   * parameter value's OriginalValue) bind, so both are always sent.
   */
  getParameterCrosses(
    parameterId: number,
    originalValue: string,
    refresh = false
  ): Promise<PanelCross[]> {
    return this.postRows<PanelCross>(
      "ParameterValueCrossed/GetParameterValueCrosses",
      {
        draw: "1",
        start: "0",
        length: "100000",
        ParameterId: String(parameterId),
        ParameterValue: originalValue,
      },
      refresh
    );
  }

  /** Cross dependency rows for one cross, from /ParameterValueCrossed/GetParameterValueCrossedDependencyList. */
  getCrossDependencies(
    parameterValueCrossedId: number,
    refresh = false
  ): Promise<PanelCrossDependency[]> {
    return this.postRows<PanelCrossDependency>(
      "ParameterValueCrossed/GetParameterValueCrossedDependencyList",
      {
        draw: "1",
        start: "0",
        length: "100000",
        parameterValueCrossedId: String(parameterValueCrossedId),
      },
      refresh
    );
  }

  /** Key dependency rows (mobile icon table on the Key screen) for one key, from /Key/GetKeyDependencyList. */
  getKeyDependencies(keyId: number, refresh = false): Promise<PanelKeyDependency[]> {
    return this.postRows<PanelKeyDependency>(
      "Key/GetKeyDependencyList",
      { draw: "1", start: "0", length: "100000", keyId: String(keyId) },
      refresh
    );
  }
}

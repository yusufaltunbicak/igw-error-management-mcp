import axios, { AxiosResponse } from "axios";
import { PanelConfig, PanelProduct, PanelKey, PanelParameter } from "../types.js";
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

  private async fetchRowsRaw<T>(path: string): Promise<T[] | null> {
    const res = await axios.post(
      `${this.baseUrl}/${path}`,
      "draw=1&start=0&length=100000",
      {
        headers: {
          Cookie: this.cookieHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
        },
        maxRedirects: 0,
        validateStatus: () => true,
      }
    );
    this.collectCookies(res);

    const body = res.data as { data?: T[] } | string;
    if (res.status === 200 && typeof body === "object" && Array.isArray(body?.data)) {
      return body.data;
    }
    // 401 / redirect to login / HTML page → session invalid
    return null;
  }

  /**
   * Fetch a full DataTables list, logging in and retrying once if the
   * session is stale. Cached per endpoint for a short TTL.
   */
  private async getAll<T>(path: string, refresh: boolean): Promise<T[]> {
    const cached = this.caches.get(path);
    if (
      !refresh &&
      cached &&
      Date.now() - cached.fetchedAt < PRODUCTS_CACHE_TTL_MS
    ) {
      return cached.data as T[];
    }

    let data = this.cookies.size > 0 ? await this.fetchRowsRaw<T>(path) : null;
    if (!data) {
      await this.login();
      data = await this.fetchRowsRaw<T>(path);
    }
    if (!data) {
      throw new Error(
        `Panel request for ${path} failed after login — panel may be down or the account lacks access`
      );
    }

    this.caches.set(path, { data, fetchedAt: Date.now() });
    return data;
  }

  /** Full product catalog from /Product/GetProducts. */
  getAllProducts(refresh = false): Promise<PanelProduct[]> {
    return this.getAll<PanelProduct>("Product/GetProducts", refresh);
  }

  /** Full key catalog from /Key/GetKeys. */
  getAllKeys(refresh = false): Promise<PanelKey[]> {
    return this.getAll<PanelKey>("Key/GetKeys", refresh);
  }

  /** Full parameter catalog from /Parameter/GetParameters. */
  getAllParameters(refresh = false): Promise<PanelParameter[]> {
    return this.getAll<PanelParameter>("Parameter/GetParameters", refresh);
  }
}

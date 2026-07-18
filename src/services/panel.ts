import axios, { AxiosResponse } from "axios";
import { PanelConfig, PanelProduct } from "../types.js";
import { PRODUCTS_CACHE_TTL_MS } from "../constants.js";

interface ProductsCache {
  data: PanelProduct[];
  fetchedAt: number;
}

/**
 * Client for the GatewayProUI admin panel (panel.insurapps.net).
 * Uses classic ASP.NET cookie auth: GET login page for the antiforgery
 * token, POST the form, keep session cookies for subsequent requests.
 */
export class PanelClient {
  private cookies = new Map<string, string>();
  private loginPromise: Promise<void> | null = null;
  private cache: ProductsCache | null = null;

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

  private async fetchProductsRaw(): Promise<PanelProduct[] | null> {
    const res = await axios.post(
      `${this.baseUrl}/Product/GetProducts`,
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

    const body = res.data as { data?: PanelProduct[] } | string;
    if (res.status === 200 && typeof body === "object" && Array.isArray(body?.data)) {
      return body.data;
    }
    // 401 / redirect to login / HTML page → session invalid
    return null;
  }

  /** Fetch the full product list, using a short-lived in-memory cache. */
  async getAllProducts(refresh = false): Promise<PanelProduct[]> {
    if (
      !refresh &&
      this.cache &&
      Date.now() - this.cache.fetchedAt < PRODUCTS_CACHE_TTL_MS
    ) {
      return this.cache.data;
    }

    let data = this.cookies.size > 0 ? await this.fetchProductsRaw() : null;
    if (!data) {
      await this.login();
      data = await this.fetchProductsRaw();
    }
    if (!data) {
      throw new Error(
        "Panel products request failed after login — panel may be down or the account lacks access to /product"
      );
    }

    this.cache = { data, fetchedAt: Date.now() };
    return data;
  }
}

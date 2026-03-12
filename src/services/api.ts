import axios, {
  AxiosInstance,
  AxiosError,
  InternalAxiosRequestConfig,
} from "axios";
import { IgwAuthManager } from "./auth.js";
import { IgwAuthConfig } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

export class IgwApiClient {
  private readonly client: AxiosInstance;
  private readonly auth: IgwAuthManager;

  constructor(config: IgwAuthConfig) {
    this.auth = new IgwAuthManager(config);
    // Ensure trailing slash so Axios resolves relative paths correctly
    const baseURL = config.baseUrl.endsWith("/")
      ? config.baseUrl
      : config.baseUrl + "/";
    this.client = axios.create({
      baseURL,
      headers: { "Content-Type": "application/json" },
    });

    // Auth interceptor — attach token to every request
    this.client.interceptors.request.use(
      async (req: InternalAxiosRequestConfig) => {
        const token = await this.auth.getValidToken();
        req.headers.Authorization = `Bearer ${token}`;
        return req;
      }
    );

    // Response interceptor — retry once on 401
    this.client.interceptors.response.use(undefined, async (error: AxiosError) => {
      const original = error.config;
      if (error.response?.status === 401 && original && !(original as any).__retried) {
        (original as any).__retried = true;
        const token = await this.auth.forceRefresh();
        original.headers.Authorization = `Bearer ${token}`;
        return this.client.request(original);
      }
      throw error;
    });
  }

  // --- Error endpoints ---

  async listErrors(filter: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.client.post("Errors", filter);
    return data;
  }

  async getErrorOperations(filter: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.client.post("/Errors/Operations", filter);
    return data;
  }

  async getErrorLogs(filter: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.client.post("/Errors/Logs", filter);
    return data;
  }

  async getErrorLogDetail(id: number): Promise<unknown> {
    const { data } = await this.client.post(`Errors/Logs/${id}`);
    return data;
  }

  async analyzeError(id: number): Promise<unknown> {
    const { data } = await this.client.get(`Errors/AnalyzeDetails/${id}`);
    return data;
  }

  // --- Error actions ---

  async pinError(body: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.client.post("/Errors/PinError", body);
    return data;
  }

  async sendErrorReport(body: Record<string, unknown>): Promise<unknown> {
    const { data } = await this.client.post("/Errors/SendErrorReport", body);
    return data;
  }

  async sendBugReport(referenceNo: string): Promise<unknown> {
    const { data } = await this.client.post(
      `Errors/SendBugReportByReferenceNo/${encodeURIComponent(referenceNo)}`
    );
    return data;
  }

  // --- Lookups ---

  async searchProducts(query?: string, page?: number, pageSize?: number): Promise<unknown> {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (page != null) params.set("page", String(page));
    if (pageSize != null) params.set("pageSize", String(pageSize));
    const qs = params.toString();
    const { data } = await this.client.get(`Products/Search${qs ? `?${qs}` : ""}`);
    return data;
  }

  async getMyInsuranceCompanies(): Promise<unknown> {
    const { data } = await this.client.get(
      "InsuranceCompanies/MyInsuranceCompanies"
    );
    return data;
  }
}

export function truncateResult(data: unknown): string {
  const json = JSON.stringify(data, null, 2);
  if (json.length <= CHARACTER_LIMIT) return json;
  return json.slice(0, CHARACTER_LIMIT) + "\n\n... [truncated — result exceeded character limit]";
}

export function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail =
      typeof error.response?.data === "string"
        ? error.response.data
        : JSON.stringify(error.response?.data ?? error.message);
    return `IGW API error (${status ?? "network"}): ${detail}`;
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

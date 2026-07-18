import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PanelClient } from "../services/panel.js";
import { truncateResult, handleApiError } from "../services/api.js";
import { PanelProduct } from "../types.js";

const PRODUCT_TYPE_NAMES: Record<number, string> = {
  0: "Default",
  1: "Yarı Online",
  2: "Dinamik",
  3: "AIR",
};

function tr(value: string): string {
  return value.toLocaleLowerCase("tr-TR");
}

export function registerProductTools(
  server: McpServer,
  panel: PanelClient
): void {
  server.tool(
    "igw_products_list",
    `List IGW products from the GatewayProUI admin panel with full details: GW product code (Id), product name, insurance company, product branch, online/offline flag, active status and the insurance company's own product code(s) (InsuranceCompanyProductCode, comma-separated).

Example: "Anadolu Sigorta konut yangın ürünleri" → insuranceCompany: "Anadolu", branch: "Konut Yangın" returns 1523 "Anadolu Sigorta Konut Offline" (offline, company codes 722,732) and 3251 "Anadolu Sigorta Konut" (online, no company code).

All filters are combined with AND. Filtering happens locally over the full product list, so any substring works regardless of Turkish casing.`,
    {
      query: z.string().optional().describe("Substring match on product name (e.g. 'Konut', 'Kasko Offline')"),
      insuranceCompany: z.string().optional().describe("Insurance company: numeric ID for exact match (e.g. '7') or name substring (e.g. 'Anadolu')"),
      branch: z.string().optional().describe("Product branch: numeric ID for exact match or name substring (e.g. 'Konut Yangın', 'Trafik')"),
      gwProductId: z.number().optional().describe("Exact GW product code (Id) lookup (e.g. 1523)"),
      companyProductCode: z.string().optional().describe("Insurance company's own product code; matches any of the comma-separated codes exactly (e.g. '722')"),
      isOnline: z.boolean().optional().describe("true = online products only, false = offline only"),
      isActive: z.boolean().optional().describe("true = active (Status) products only, false = passive only"),
      productType: z.number().optional().describe("Product type: 0=Default, 1=Yarı Online, 2=Dinamik, 3=AIR"),
      hasPolicyInLastThreeMonths: z.boolean().optional().describe("Filter by whether the product produced a policy in the last three months"),
      refresh: z.boolean().optional().describe("Bypass the 10-minute cache and refetch from the panel"),
      page: z.number().optional().describe("Page number over the filtered result (default 1)"),
      pageSize: z.number().optional().describe("Page size (default 50)"),
    },
    async (args) => {
      try {
        const all = await panel.getAllProducts(args.refresh === true);

        const companyFilter = args.insuranceCompany?.trim();
        const companyId =
          companyFilter && /^\d+$/.test(companyFilter)
            ? Number(companyFilter)
            : null;
        const branchFilter = args.branch?.trim();
        const branchId =
          branchFilter && /^\d+$/.test(branchFilter)
            ? Number(branchFilter)
            : null;

        const filtered = all.filter((p: PanelProduct) => {
          if (args.gwProductId != null && p.Id !== args.gwProductId) return false;
          if (args.query && !tr(p.Name).includes(tr(args.query))) return false;
          if (companyId != null) {
            if (p.InsuranceCompanyId !== companyId) return false;
          } else if (companyFilter) {
            if (!tr(p.InsuranceCompany).includes(tr(companyFilter))) return false;
          }
          if (branchId != null) {
            if (p.ProductBranchId !== branchId) return false;
          } else if (branchFilter) {
            if (!tr(p.ProductBranch).includes(tr(branchFilter))) return false;
          }
          if (args.companyProductCode) {
            const codes = (p.InsuranceCompanyProductCode ?? "")
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean);
            if (!codes.includes(args.companyProductCode.trim())) return false;
          }
          if (args.isOnline != null && p.IsOnline !== args.isOnline) return false;
          if (args.isActive != null && p.Status !== args.isActive) return false;
          if (args.productType != null && p.ProductType !== args.productType) return false;
          if (
            args.hasPolicyInLastThreeMonths != null &&
            p.HasPolicyInLastThreeMonths !== args.hasPolicyInLastThreeMonths
          )
            return false;
          return true;
        });

        const page = args.page && args.page > 0 ? args.page : 1;
        const pageSize = args.pageSize && args.pageSize > 0 ? args.pageSize : 50;
        const start = (page - 1) * pageSize;
        const rows = filtered.slice(start, start + pageSize).map((p) => ({
          GwProductCode: p.Id,
          Name: p.Name,
          InsuranceCompanyId: p.InsuranceCompanyId,
          InsuranceCompany: p.InsuranceCompany,
          ProductBranchId: p.ProductBranchId,
          ProductBranch: p.ProductBranch,
          InsuranceCompanyProductCode: p.InsuranceCompanyProductCode,
          IsOnline: p.IsOnline,
          IsActive: p.Status,
          ProductType: p.ProductType,
          ProductTypeName: PRODUCT_TYPE_NAMES[p.ProductType] ?? String(p.ProductType),
          HasPolicyInLastThreeMonths: p.HasPolicyInLastThreeMonths,
          SaveOfferGuaranteeDetail: p.SaveOfferGuaranteeDetail,
          IsValidOfflineForProposal: p.IsValidOfflineForProposal,
          OfflineErrorExplanation: p.OfflineErrorExplanation,
        }));

        const result = {
          totalProducts: all.length,
          matched: filtered.length,
          page,
          pageSize,
          returned: rows.length,
          products: rows,
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

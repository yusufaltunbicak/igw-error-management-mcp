export interface IgwAuthConfig {
  baseUrl: string;
  username: string;
  password: string;
  webApiKey: string;
}

export interface IgwTokenResponse {
  Token: string;
  RefreshToken: string;
  Expiration: string;
}

export interface IgwErrorFilter {
  BeginDate?: string;
  EndDate?: string;
  BranchId?: number;
  ProductId?: number;
  InsuranceCompanyId?: number;
  ServiceOperationId?: number;
  NotAnalysed?: boolean;
  Solved?: boolean;
  InProgress?: boolean;
  NothingToDo?: boolean;
  UserMistake?: boolean;
  ConnectionError?: boolean;
  OperationTimeout?: boolean;
  PageNumber?: number;
  PageSize?: number;
}

export interface IgwErrorItem {
  id: number;
  referenceNo: string;
  branchName: string;
  productName: string;
  insuranceCompanyName: string;
  serviceOperationName: string;
  statusName: string;
  createdDate: string;
  errorMessage: string;
}

export interface IgwProductSearchParams {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface IgwPinErrorRequest {
  errorId: number;
  isPinned: boolean;
}

export interface IgwSendErrorReportRequest {
  errorId: number;
  description: string;
}

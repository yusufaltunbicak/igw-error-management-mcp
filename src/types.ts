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
  beginDate?: string;
  endDate?: string;
  agentId?: number;
  branchId?: number;
  productId?: number;
  insuranceCompanyId?: number;
  serviceOperationId?: number;
  notAnalysed?: boolean;
  solved?: boolean;
  inProgress?: boolean;
  nothingToDo?: boolean;
  userMistake?: boolean;
  connectionError?: boolean;
  operationTimeout?: boolean;
  errorQuery?: string;
  includeProducts?: boolean;
  clientChannel?: string;
  page?: number;
  pageSize?: number;
  sortColumn?: string;
  sortDescending?: boolean;
}

export interface IgwErrorItem {
  AgentId: number;
  AgentName: string;
  ProductId: number;
  ProductName: string;
  ErrorExplanation: string;
  GroupCount: number;
  LastErrorDate: string;
  InsuranceCompanyID: number;
  InsuranceCompanyName: string;
  ProductBranchName: string;
  ErrorExplanationHash: string;
  PatternText: string | null;
  ErrorPatternId: number | null;
  FailedOperationId: string;
  AnalyzeStatus: number | null;
  ClientChannel: string;
  ServiceOperationID: number;
}

export interface IgwErrorCategories {
  [serviceOperationId: string]: {
    NotPinned: number;
    Solved: number;
    InProgress: number;
    NothingToDo: number;
    UserMistake: number;
    ConnectionError: number;
    OperationTimeout: number;
  };
}

export interface IgwErrorListResponse {
  ErrorCategories: IgwErrorCategories;
  Errors: IgwErrorItem[];
}

export interface IgwProductSearchParams {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface PanelConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export interface ManagementConsoleConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export type ManagementConsoleSearchType =
  | "requestId"
  | "proposalId"
  | "referanceNo"
  | "exceptionLogId"
  | "policyId"
  | "jobId"
  | "insuranceCompanyProposalId"
  | "platformProposalId";

export type ManagementConsoleDirection = "all" | "outgoing" | "incoming";
export type ManagementConsoleLogType = "Outgoing" | "Incoming";
export type ManagementConsolePayloadSide = "sent" | "received";
export type ManagementConsolePayloadFormat = "json" | "xml" | "text";

export interface ManagementConsoleAgentHeading {
  id: string;
  name: string;
}

export interface ManagementConsoleOutgoingLog {
  logId: string;
  referenceNo: string;
  proposalId: string;
  product: string;
  action: string;
  requestDate: string;
  elapsedMs: string;
}

export interface ManagementConsoleIncomingLog {
  logId: string;
  referenceNo: string;
  action: string;
  requestDate: string;
  elapsedMs: string;
  machineName: string;
}

export interface ManagementConsoleParsedSearch {
  agents: ManagementConsoleAgentHeading[];
  outgoingLogs: ManagementConsoleOutgoingLog[];
  incomingLogs: ManagementConsoleIncomingLog[];
}

export interface ManagementConsoleSearchParams {
  searchType: ManagementConsoleSearchType;
  value: string;
  includeInternalLogs?: boolean;
  direction?: ManagementConsoleDirection;
  page?: number;
  pageSize?: number;
}

export interface ManagementConsolePayloadParams {
  logId: string;
  logType: ManagementConsoleLogType;
  payloadSide: ManagementConsolePayloadSide;
  offset?: number;
  maxChars?: number;
}

export interface ManagementConsoleIncomingLogsParams {
  beginDate: string;
  endDate: string;
  agentId?: string | number;
  serviceOperationId?: string | number;
  outSourceProcessId?: string | number;
  insuranceCompanyId?: string | number;
  page?: number;
  pageSize?: number;
}

export interface ManagementConsoleIncomingLogsResponse {
  data: ManagementConsoleIncomingListLog[];
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
}

export interface ManagementConsoleIncomingListLog {
  logId: string;
  referenceNo: string;
  agentId: string;
  action: string;
  requestDate: string;
  elapsedMs: string;
  machineName: string;
  ipAddress: string;
}

/** Row shape returned by GatewayProUI /Product/GetProducts */
export interface PanelProduct {
  Id: number;
  Name: string;
  InsuranceCompanyId: number;
  InsuranceCompany: string;
  ProductBranch: string;
  ProductBranchId: number;
  InsuranceCompanyProductCode: string | null;
  Status: boolean;
  IsOnline: boolean;
  SaveOfferGuaranteeDetail: boolean;
  HasPolicyInLastThreeMonths: boolean;
  IsValidOfflineForProposal: boolean;
  OfflineErrorExplanation: string | null;
  ProductType: number;
}

/** Row shape returned by GatewayProUI /Key/GetKeys */
export interface PanelKey {
  Id: number;
  KeyName: string;
  Parameterized: boolean;
  ParameterId: number | null;
  ParameterName: string | null;
  KeyValueType: string;
  Depent: boolean;
  Status: boolean;
}

/** Row shape returned by GatewayProUI /Parameter/GetParameters */
export interface PanelParameter {
  ParameterId: number;
  ParameterName: string;
  Dependent: boolean;
}

/** Row shape returned by GatewayProUI /ParameterValue/GetParameterValues?parameterId=… */
export interface PanelParameterValue {
  ParameterId: number;
  /** Human-readable label of the value (e.g. "30.000-90.000-30.000") */
  Text: string;
  /** Original value sent to the parameter system (OriginalValue) */
  Value: string;
  /** Whether any cross is defined for this value */
  Crossed: boolean;
  /** Air-specific flag (special handling on the panel) */
  IsAirSpecific: boolean;
  /** Active / passive */
  Status: boolean;
}

/** Row shape returned by GatewayProUI /ParameterValueCrossed/GetParameterValueCrosses */
export interface PanelCross {
  ParameterValueCrossedId: number;
  ParameterId: number;
  /** The parameter value (OriginalValue) this cross belongs to */
  OriginalValue: string;
  InsuranceCompanyId: number;
  InsuranceCompanyName: string | null;
  /** -1 / Tanımsız = cross applies to all of the company's products */
  ProductId: number | null;
  ProductName: string | null;
  /** Tanımsız 0 / Acente 1 / Broker 2 / Banka 3 / Sigorta Şirketi 4 */
  AgentType: number;
  /** IGW's own label for the cross — never used in IUP, differing is not an error */
  CrossName: string;
  /** The value that actually goes to the company ("0" = unsupported in this context) */
  CrossValue: string;
  /** True when the cross has dependency conditions */
  Dependent: boolean;
  /** Convergence flag — not used in IUP */
  IsConverged: boolean;
}

/** Row shape returned by GatewayProUI /ParameterValueCrossed/GetParameterValueCrossedDependencyList */
export interface PanelCrossDependency {
  Id: number;
  ParameterValueCrossedId: number;
  ParameterId: number;
  ParameterValue: string;
  InsuranceCompanyId: number;
  ProductId: number;
  CrossValue: string;
  /** The key whose condition this row evaluates (e.g. Acente ID / Parent ID) */
  DependentKeyId: number;
  DependentKeyName: string;
  /** The key value the condition compares against */
  DependentKeyValue: string;
  /** =, !=, >, <, [==] (contains), [!=] (does not contain) */
  DependencyType: string;
  DependencyGroupNo: number | null;
  /** How this dependency group connects to the next group (&& / ||) */
  DependencyGroupConnectionTypeToOtherGroup: string | null;
  /** How this row connects to the next row inside its group (&& / ||) */
  DependencyConnectionTypeToOtherKey: string | null;
  DependencyExecutionLevelForOtherKey: number | null;
}

/** Row shape returned by GatewayProUI /Key/GetKeyDependencyList?keyId=… */
export interface PanelKeyDependency {
  Id: number;
  DependentKeyId: number;
  DependentKeyName: string;
  DependentKeyValue: string;
  KeyName: string;
  KeyId: number;
  DependencyType: string;
  DependencyConnectionTypeToOtherKey: string | null;
  DependencyExecutionLevelForOtherKey: number | null;
}

export interface IgwPinErrorRequest {
  errorId: number;
  isPinned: boolean;
}

export interface IgwSendErrorReportRequest {
  errorId: number;
  description: string;
}

export interface IgwUpdateStatusRequest {
  errorExplanationHash: string;
  analyzeStatus: number;
  serviceOperationId?: number;
}

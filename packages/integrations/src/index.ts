/**
 * @nell/integrations
 *
 * Connectors to third-party accounts, behind quarantined readers.
 *
 * The rule that shapes this package: raw third-party prose and tool access never
 * share a context. Content goes to an extractor with no tools, which returns
 * schema-validated fields tagged untrusted; the planner sees only that.
 *
 * Governed by: docs/security-model.md
 */

export {
  detectSuspiciousContent,
  extract,
  extractOtp,
  messageSummarySchema,
  otpExtractionSchema,
  type Extracted,
  type Extractor,
  type MessageSummary,
  type OtpExtraction,
  type RawContent,
} from "./quarantine.js";

export {
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  preferSearch,
  renderFindings,
  searchResultSchema,
  searchWeb,
  type SearchFindings,
  type SearchOptions,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from "./search.js";
export {
  anthropicSearchProvider,
  DEFAULT_SEARCH_MODEL,
  type AnthropicSearchOptions,
} from "./anthropic-search.js";

export {
  asRawContent,
  draftReply,
  emailAddressSchema,
  flagInjectionAttempt,
  MAX_MESSAGES,
  mailGistSchema,
  mailSummarySchema,
  readMail,
  renderMail,
  type DraftCreated,
  type DraftOptions,
  type DraftOutcome,
  type DraftRefusalReason,
  type DraftRequest,
  type EmailMessage,
  type MailGist,
  type MailProvider,
  type MailQuery,
  type MailReading,
  type MailSummary,
  type ReadMailOptions,
} from "./gmail.js";

export {
  callTool,
  checkForDrift,
  explainProblem,
  fingerprintTool,
  mcpToolSchema,
  qualify,
  registerTools,
  renderResult,
  renderTools,
  MAX_DESCRIPTION_LENGTH,
  MAX_RESULT_LENGTH,
  MAX_TOOLS_PER_SERVER,
  type CallOptions,
  type DriftCheck,
  type DriftReason,
  type McpClient,
  type McpResult,
  type McpServerConfig,
  type McpTool,
  type RegisteredTool,
  type Registration,
  type RegistrationProblem,
} from "./mcp.js";

export {
  applyChange,
  describePlan,
  likelyMisfiled,
  mailOperationSchema,
  planChange,
  undoChange,
  BULK_APPROVAL_THRESHOLD,
  MAX_BATCH,
  type ApplyOptions,
  type ApplyOutcome,
  type MailChange,
  type MailOperation,
  type MailWriteProvider,
  type Plan,
  type PlanOptions,
  type UndoRecord,
} from "./mail-write.js";

export {
  attendeeSchema,
  checkWrite,
  conflictsWith,
  describeTrigger,
  findFreeSlots,
  hourInZone,
  isFree,
  meetingTriggers,
  shiftByDays,
  wallClockIn,
  IMMINENT_MINUTES,
  MAX_EVENT_MS,
  PREP_LEAD_MINUTES,
  TRAVEL_LEAD_MINUTES,
  type Attendee,
  type CalendarEvent,
  type CalendarProvider,
  type CalendarWindow,
  type Conflict,
  type MeetingTrigger,
  type SlotSearch,
  type WriteCheck,
  type WriteDecision,
  type WriteRefusal,
} from "./calendar.js";

export {
  asReading,
  checkWorkspaceWrite,
  describeTarget,
  fromGitHub,
  fromLinear,
  fromNotion,
  fromSlack,
  renderItems,
  reviewScopes,
  workspaceServiceSchema,
  MAX_BODY_LENGTH,
  MAX_ITEMS,
  REQUIRED_SCOPES,
  type ItemKind,
  type ScopeReview,
  type WorkspaceItem,
  type WorkspaceReading,
  type WorkspaceService,
  type WorkspaceWriteDecision,
  type WriteContext,
  type WriteRequest,
  type WriteTarget,
} from "./workspace.js";

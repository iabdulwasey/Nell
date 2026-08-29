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

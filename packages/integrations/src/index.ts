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

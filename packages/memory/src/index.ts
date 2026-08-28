/**
 * @nell/memory
 *
 * Tier 1 (preference profile) and tier 2 (episodic task ledger): the memory that
 * makes the agent feel like it knows you, and the record that makes "book it
 * like last time" possible.
 *
 * Untrusted content can never write a preference — a preference is effectively a
 * standing instruction, so accepting one from a web page would be prompt
 * injection with persistence.
 *
 * Governed by: docs/architecture.md
 */

export {
  forgetPreference,
  liveProfile,
  MAX_VALUE_LENGTH,
  preferenceCategorySchema,
  renderProfile,
  writePreference,
  type Preference,
  type PreferenceCategory,
  type WriteOptions,
  type WriteRejection,
  type WriteResult,
} from "./preferences.js";

export {
  lastSuccessAt,
  recall,
  recordTask,
  renderPrecedents,
  sanitizeDetail,
  taskOutcomeSchema,
  type LedgerEntry,
  type RecallQuery,
  type RecordOptions,
  type TaskOutcome,
} from "./ledger.js";

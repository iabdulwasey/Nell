/**
 * @nell/browser
 *
 * The BrowserProvider port (cloud + local-Chromium adapters) and the typed
 * browser-action DSL. No model-authored code ever runs on a session.
 *
 * Governed by: docs/architecture.md, docs/security-model.md
 */

export {
  actionBatchSchema,
  actionSchema,
  operationClassOf,
  parseActionBatch,
  targetSchema,
  validateTarget,
  type BrowserAction,
  type Target,
} from "./dsl.js";

export type {
  ActionResult,
  BrowserProvider,
  BrowserSession,
  CreateSessionOptions,
} from "./provider.js";

export { LocalBrowserProvider, type LocalBrowserOptions } from "./adapters/local.js";

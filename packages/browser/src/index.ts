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

export {
  anthropicToolSpec,
  assertOnScreen,
  computerActionSchema,
  fromAnthropicAction,
  fromOpenAIAction,
  genericToolSpec,
  keyNameSchema,
  KEY_NAMES,
  MACHINE_VIEWPORT,
  MODEL_DISPLAY,
  modifierSchema,
  openaiToolSpec,
  operationClassOfComputerAction,
  pointSchema,
  projectAction,
  toDisplay,
  toViewport,
  type ComputerAction,
  type CoordinateSpace,
  type DisplaySize,
  type KeyName,
  type Modifier,
  type Point,
} from "./computer.js";

export {
  IDLE_BEFORE_STANDBY_MS,
  MachineRegistry,
  type ActOutcome,
  type DestroyReceipt,
  type Machine,
  type MachineHost,
  type MachineState,
  type RegistryOptions,
} from "./machine.js";

export type {
  ActionResult,
  BrowserProvider,
  BrowserSession,
  CreateSessionOptions,
} from "./provider.js";

export { LocalBrowserProvider, type LocalBrowserOptions } from "./adapters/local.js";

export {
  buildSnapshot,
  choosePerception,
  estimateTokens,
  isInteractive,
  isWorthShowing,
  MAX_NODES,
  MAX_TEXT_CHARS,
  renderSnapshot,
  SCREENSHOT_TOKENS,
  snapshotNodeSchema,
  VISION_AFTER_FAILURES,
  type BuildSnapshotInput,
  type PageSnapshot,
  type PerceptionDecision,
  type PerceptionInput,
  type PerceptionReason,
  type SnapshotNode,
} from "./perception.js";

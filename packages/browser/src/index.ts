/**
 * @nell/browser
 *
 * The BrowserProvider port (cloud + local-Chromium adapters) and the typed
 * browser-action DSL. No model-authored code ever runs on a session.
 *
 * Governed by: docs/architecture.md, docs/security-model.md
 */

export { detectBlock, explainBlock, type BlockKind, type BlockVerdict } from "./blocked.js";
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
  isClipboardChord,
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

/**
 * The adapters are NOT exported here.
 *
 * They carry a browser binary, and this entry point is imported by everything
 * that only needs the vocabulary — the policy engine, the view layer, the eval
 * harness. Re-exporting them from the root would drag Playwright into a
 * dashboard bundle, which is both absurd in size and wrong in principle: a view
 * should not be able to reach a driver.
 *
 * Import them from `@nell/browser/adapters`.
 */
export type { CaptureOptions } from "./provider.js";

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

export {
  canEnter,
  checkpoint,
  completeStep,
  expiredRaces,
  explainRaceRefusal,
  finishRace,
  needsKeepalive,
  readiness,
  restore,
  KEEPALIVE_INTERVAL_MS,
  MAX_RACE_DURATION_MS,
  READINESS_STEPS,
  type RaceCheckpoint,
  type RaceDecision,
  type RaceRefusal,
  type RaceState,
  type Readiness,
  type ReadinessStep,
} from "./race.js";

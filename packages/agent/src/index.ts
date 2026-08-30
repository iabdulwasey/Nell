/**
 * @nell/agent
 *
 * The coordinator/worker agent runtime: prompts, tool registry, the ModelRouter,
 * and the briefing composer. The coordinator owns the relationship and never
 * drives a browser or sees secrets; workers run one durable workflow per task.
 *
 * Governed by: docs/architecture.md
 */

export {
  MAX_TOOL_RESULTS,
  searchTool,
  type SearchToolOptions,
  type WebSearch,
} from "./search-tool.js";

export {
  DEFAULT_IMAGE_MODEL,
  imageTool,
  type ImageToolOptions,
  type ImageVendor,
} from "./image.js";

export {
  checkUrl,
  fetchTool,
  MAX_DOWNLOAD_BYTES,
  MAX_REDIRECTS,
  type BrowserFetch,
  type FetchToolOptions,
  type UrlVerdict,
} from "./fetch-url.js";
export {
  capabilitiesOf,
  CAPABILITY_LABELS,
  describe as describeCapabilities,
  mergeAssignments,
  modelCapabilitySchema,
  overridesFromEnv,
  report as capabilityReport,
  resolve as resolveCapabilities,
  VENDOR_CAPABILITIES,
  VENDOR_NAMES,
  type Assignment,
  type CapabilityReport,
  type ModelCapability,
  type ResolvedCapability,
} from "./capabilities.js";
export {
  assist,
  type AssistOutcome,
  type AssistRequest,
  type ClientTool,
  type ProducedFile,
  type SuppliedFile,
} from "./assistant.js";
export {
  capabilitySchema,
  explainUnsupported,
  planWork,
  unsupported,
  type Capability,
  type Dispatch,
  type DispatchRequest,
  type Step,
} from "./dispatch.js";
export {
  buildVisionSchema,
  planFromScreen,
  visionSchema,
  VISION_PROMPT,
  type VisionOutcome,
  type VisionPlan,
  type VisionRequest,
} from "./vision.js";
export {
  CACHE_DISCOUNT,
  checkBudget,
  costOf,
  ESCALATE_AFTER_FAILURES,
  modelTierSchema,
  route,
  UsageMeter,
  type BudgetDecision,
  type BudgetState,
  type ModelCatalog,
  type ModelSpec,
  type ModelTier,
  type RouteDecision,
  type RouteRequest,
  type Usage,
} from "./model-router.js";

export {
  activeTasks,
  admit,
  canTransition,
  DEFAULT_CONCURRENCY,
  isActive,
  isTerminal,
  runningCount,
  taskStatusSchema,
  transition,
  type Task,
  type TaskStatus,
  type TransitionResult,
} from "./tasks.js";

export {
  coalesce,
  isBareReply,
  QUIET_WINDOW_MS,
  routeMessage,
  type CoalesceResult,
  type InboundMessage,
  type ProgressEvent,
  type RouteTarget,
} from "./steering.js";

export {
  assertNoSecrets,
  composeBriefing,
  type Briefing,
  type BriefingInput,
  type BudgetEnvelope,
  type VaultHandle,
} from "./briefing.js";

export {
  drainQueue,
  handleMessage,
  handleWorkerResult,
  progressFrom,
  type CoordinatorState,
  type Effect,
  type HandleMessageInput,
  type Intent,
  type WorkerResult,
} from "./coordinator.js";

export {
  buildCatalog,
  catalogLookup,
  explainProblem,
  optionsForTier,
  providerSchema,
  REFERENCE_CATALOG,
  validateCatalog,
  type CatalogEntry,
  type CatalogProblem,
  type CatalogSelection,
  type Provider,
} from "./catalog.js";

export {
  anthropicProvider,
  explainProviderProblem,
  keysFromEnv,
  openAiCompatibleProvider,
  providerFor,
  DEFAULT_TIMEOUT_MS,
  type CompletionOutcome,
  type CompletionRequest,
  type ModelMessage,
  type ModelProvider,
  type ProviderKeys,
  type ProviderProblem,
  type ProviderResolution,
  type TokenUsage,
} from "./provider.js";

export {
  explainPlanFailure,
  planNext,
  planSchema,
  SYSTEM_PROMPT,
  type Plan,
  type PlanFailure,
  type PlanOutcome,
  type PlanRequest,
} from "./planner.js";

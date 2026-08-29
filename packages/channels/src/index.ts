/**
 * @nell/channels
 *
 * The ChannelPort contract, the canonical inbound envelope, and per-channel
 * renderers. Channels differ in ways that matter — native threads vs a flat
 * conversation, markdown vs literal asterisks, message length caps — and those
 * differences are declared as capabilities rather than scattered through the
 * agent.
 *
 * Governed by: docs/architecture.md
 */

export {
  channelKindSchema,
  inboundKey,
  type ChannelCapabilities,
  type ChannelKind,
  type ChannelPort,
  type DeliveryReceipt,
  type InboundEnvelope,
  type OutboundMessage,
  type ThreadTopology,
} from "./port.js";

export {
  CAPABILITIES,
  render,
  renderChoices,
  splitMessage,
  tagForTask,
  toPlainText,
} from "./render.js";

export {
  SECRET_HEADER,
  TELEGRAM_CAPABILITIES,
  TELEGRAM_MAX_MESSAGE,
  TelegramChannel,
  toTelegramHtml,
  type TelegramOptions,
  type TelegramRequest,
  type TelegramTransport,
} from "./telegram.js";

export {
  chooseSendMode,
  toWhatsAppFormatting,
  SERVICE_WINDOW_MS,
  SIGNATURE_HEADER,
  TEMPLATES,
  WhatsAppChannel,
  WHATSAPP_CAPABILITIES,
  WHATSAPP_MAX_MESSAGE,
  type MessageTemplate,
  type SendMode,
  type WhatsAppOptions,
  type WhatsAppRequest,
  type WhatsAppTransport,
} from "./whatsapp.js";

export {
  complianceKeyword,
  complianceReply,
  IMessageChannel,
  IMESSAGE_CAPABILITIES,
  IMESSAGE_MAX_MESSAGE,
  IMESSAGE_SIGNATURE_HEADER,
  type ComplianceKeyword,
  type IMessageOptions,
  type IMessageRequest,
  type IMessageTransport,
} from "./imessage.js";

export {
  canCommit,
  canRecord,
  canSpeak,
  checkVoiceConfig,
  disclosure,
  endCall,
  explainVoiceConfigProblem,
  explainVoiceRefusal,
  interpretConsent,
  markDisclosed,
  needsRecordingConsent,
  recordConsent,
  recordingRequest,
  reportCall,
  startCall,
  callDirectionSchema,
  callOutcomeSchema,
  voiceModeSchema,
  ALL_PARTY_CONSENT,
  REALTIME_MODELS,
  type CallDirection,
  type CallOutcome,
  type CallPhase,
  type CallReport,
  type CallState,
  type StartCallOptions,
  type VoiceConfigProblem,
  type VoiceDecision,
  type VoiceMode,
  type VoiceModelChoice,
  type VoiceRefusal,
} from "./voice.js";

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

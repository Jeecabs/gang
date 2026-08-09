export const EXTENSION_BUS_FEATURE = "extension-bus-v1";

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  /** Live context-window usage, pushed via presence from the source session's
   *  getContextUsage(). contextPct is 0..100 (rounded); contextTokens /
   *  contextWindow are raw token counts. All optional: unknown right after a
   *  compaction (before the next assistant response), when no model is selected,
   *  or on older clients that never report it. */
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface SubagentMessageMetadata {
  runId: string;
  agent: string;
  index: string;
  final: boolean;
}

export interface Message {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  subagent?: SubagentMessageMetadata;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type MessageReceiptStatus = "receiver_received" | "queued" | "injected" | "acknowledged" | "expired" | "cancelled" | "superseded" | "cancellation_requested";

export interface MessageReceipt {
  messageId: string;
  status: MessageReceiptStatus;
  timestamp: number;
  detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
  messageId: string;
  action: MessageControlAction;
  timestamp: number;
  supersededBy?: string;
  detail?: string;
}

export interface ExtensionCapability {
  namespace: string;
  ownerEligible: boolean;
}

export type SessionRegistration = Omit<SessionInfo, "id" | "peerUid" | "trustedLocal"> & {
  extensions?: ExtensionCapability[];
};

function isSubagentMessageMetadata(value: unknown): value is SubagentMessageMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return typeof metadata.runId === "string"
    && typeof metadata.agent === "string"
    && typeof metadata.index === "string"
    && typeof metadata.final === "boolean";
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") return false;
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") return false;
  return attachment.language === undefined || typeof attachment.language === "string";
}

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") return false;
  for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"] as const) {
    if (message[key] !== undefined && typeof message[key] !== "number") return false;
  }
  if (message.supersedes !== undefined && typeof message.supersedes !== "string") return false;
  if (message.retryOf !== undefined && typeof message.retryOf !== "string") return false;
  if (message.replyTo !== undefined && typeof message.replyTo !== "string") return false;
  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") return false;
  if (message.subagent !== undefined && !isSubagentMessageMetadata(message.subagent)) return false;
  if (typeof message.content !== "object" || message.content === null || Array.isArray(message.content)) return false;
  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") return false;
  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

export function isSessionRegistration(value: unknown): value is SessionRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) return false;
  if (session.name !== undefined && typeof session.name !== "string") return false;
  if (session.status !== undefined && typeof session.status !== "string") return false;
  for (const key of ["contextPct", "contextTokens", "contextWindow"] as const) {
    if (session[key] !== undefined && typeof session[key] !== "number") return false;
  }
  return session.extensions === undefined || Array.isArray(session.extensions);
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isSessionRegistration(value)) return false;
  const session = value as unknown as Record<string, unknown>;
  if (typeof session.id !== "string") return false;
  if (session.peerUid !== undefined && typeof session.peerUid !== "number") return false;
  return session.trustedLocal === undefined || typeof session.trustedLocal === "boolean";
}

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string }
  | { type: "unregister" }
  | { type: "extension_capabilities_update"; extensions: ExtensionCapability[] }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "message_receipt"; receipt: MessageReceipt }
  | { type: "cancel_message"; messageId: string }
  | { type: "cancel_ask"; messageId: string }
  | { type: "presence"; name?: string; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }
  | {
      type: "extension_publish";
      namespace: string;
      audience: "owner" | "capable";
      ownerEpoch?: string;
      ownerOnly?: boolean;
      payload: unknown;
    }
  | {
      type: "extension_state_commit";
      namespace: string;
      ownerEpoch: string;
      expectedRevision: number;
      payload: unknown;
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  | { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
  | { type: "message_control"; from: SessionInfo; control: MessageControl }
  | { type: "extension_owner"; namespace: string; ownerId?: string; ownerEpoch?: string }
  | {
      type: "extension_message";
      namespace: string;
      fromSessionId: string;
      ownerId?: string;
      ownerEpoch?: string;
      payload: unknown;
    }
  | {
      type: "extension_state";
      namespace: string;
      revision: number;
      payload: unknown;
    }
  | {
      type: "extension_state_result";
      namespace: string;
      committed: boolean;
      revision: number;
      reason?: string;
    };

export interface SessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
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

function isSubagentMessageMetadata(value: unknown): value is SubagentMessageMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return typeof metadata.runId === "string"
    && typeof metadata.agent === "string"
    && typeof metadata.index === "string"
    && typeof metadata.final === "boolean";
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) return false;
  const attachment = value as Record<string, unknown>;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") return false;
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") return false;
  return attachment.language === undefined || typeof attachment.language === "string";
}

export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") return false;
  if (message.replyTo !== undefined && typeof message.replyTo !== "string") return false;
  if (message.expectsReply !== undefined && typeof message.expectsReply !== "boolean") return false;
  if (message.subagent !== undefined && !isSubagentMessageMetadata(message.subagent)) return false;
  if (typeof message.content !== "object" || message.content === null) return false;
  const content = message.content as Record<string, unknown>;
  if (typeof content.text !== "string") return false;
  return content.attachments === undefined
    || (Array.isArray(content.attachments) && content.attachments.every(isAttachment));
}

export function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
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
  return session.status === undefined || typeof session.status === "string";
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  return isSessionRegistration(value)
    && typeof (value as Record<string, unknown>).id === "string";
}

export type ClientMessage =
  | { type: "register"; session: Omit<SessionInfo, "id"> }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "presence"; name?: string; status?: string; model?: string };

export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string };

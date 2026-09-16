export const SUPERINTENDENT_NAMED_EVENT = "gang:superintendent-named";
export const GANG_MEMBER_REPORT_EVENT = "gang:member-report";
/** Sync request: the intercom extension fills `sessionId` with its registered bus ID. */
export const INTERCOM_SESSION_ID_REQUEST_EVENT = "gang:intercom-session-id";

export interface IntercomSessionIdRequest {
  sessionId?: string;
}

export interface GangMemberReportEvent {
  fromId: string;
  fromName?: string;
  text: string;
  timestamp: number;
  expectsReply: boolean;
  replyTo?: string;
  subagent?: {
    runId: string;
    agent: string;
    index: string;
    final: boolean;
  };
}

export const SUPERINTENDENT_NAMED_EVENT = "gang:superintendent-named";
export const GANG_MEMBER_REPORT_EVENT = "gang:member-report";

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

export const BOSS_NAMED_EVENT = "gang:boss-named";
export const GANG_MEMBER_REPORT_EVENT = "gang:member-report";

export interface GangMemberReportEvent {
  fromId: string;
  fromName?: string;
  text: string;
  timestamp: number;
  expectsReply: boolean;
  replyTo?: string;
}

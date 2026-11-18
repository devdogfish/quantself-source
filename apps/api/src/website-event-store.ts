import { prisma } from "@quantself/db";
import type { PrismaClient, WebsiteInquiryStatus } from "@quantself/db/generated/prisma/client";
import type { WebsiteEvent, WebsiteInquiryInput } from "./website-event-contract";

export function websiteEventStore(
  db: Pick<PrismaClient, "websiteEvent" | "websiteInquiry"> = prisma,
) {
  return {
    async insertEvents(events: WebsiteEvent[]) {
      const { count } = await db.websiteEvent.createMany({
        data: events.map(event => ({
          id: event.id,
          occurredAt: new Date(event.occurred_at),
          kind: event.kind,
          visitorId: event.visitor_id,
          sessionId: event.session_id,
          pageViewId: event.page_view_id,
          ipId: event.ip_id,
          path: event.path,
          linkCode: event.link_code,
          utmSource: event.utm_source,
          utmMedium: event.utm_medium,
          utmCampaign: event.utm_campaign,
          referrerHost: event.referrer_host,
          device: event.device,
          props: event.props,
        })),
        skipDuplicates: true,
      });
      return count;
    },
    async insertInquiry({ link_code, ...inquiry }: WebsiteInquiryInput) {
      await db.websiteInquiry.createMany({
        data: { ...inquiry, linkCode: link_code },
        skipDuplicates: true,
      });
    },
    async updateInquiryStatus(id: string, status: WebsiteInquiryStatus) {
      const { count } = await db.websiteInquiry.updateMany({ where: { id }, data: { status } });
      return count === 1;
    },
  };
}

export type WebsiteEventStore = ReturnType<typeof websiteEventStore>;

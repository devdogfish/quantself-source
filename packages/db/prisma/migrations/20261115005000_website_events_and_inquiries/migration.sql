-- CreateEnum
CREATE TYPE "website_inquiry_status" AS ENUM ('new', 'replied', 'call_booked', 'won', 'lost');

-- CreateTable
CREATE TABLE "website_event" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" VARCHAR(24) NOT NULL,
    "visitor_id" UUID,
    "session_id" UUID,
    "page_view_id" UUID,
    "ip_id" VARCHAR(64),
    "path" VARCHAR(240) NOT NULL,
    "link_code" VARCHAR(64),
    "utm_source" VARCHAR(100),
    "utm_medium" VARCHAR(100),
    "utm_campaign" VARCHAR(100),
    "referrer_host" VARCHAR(253),
    "device" VARCHAR(7),
    "props" JSONB NOT NULL,

    CONSTRAINT "website_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_inquiry" (
    "id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "topic" VARCHAR(120) NOT NULL,
    "message" TEXT NOT NULL,
    "link_code" VARCHAR(64),
    "status" "website_inquiry_status" NOT NULL DEFAULT 'new',

    CONSTRAINT "website_inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "website_event_occurred_at_idx" ON "website_event" USING BRIN ("occurred_at");

-- CreateIndex
CREATE INDEX "website_event_kind_occurred_at_idx" ON "website_event"("kind", "occurred_at");

-- CreateIndex
CREATE INDEX "website_event_link_code_idx" ON "website_event"("link_code");

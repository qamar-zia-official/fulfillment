ALTER TABLE "webhook_events" ALTER COLUMN "status" SET DEFAULT 'received';--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "variant_id" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfillable_quantity" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "requires_shipping" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "financial_status" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_address_line1" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_address_line2" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_city" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_province" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_postal_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_country_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_test_order" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "triggered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "order_items_sku_idx" ON "order_items" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "orders_routable_idx" ON "orders" USING btree ("created_at") WHERE "orders"."status" = 'pending' and "orders"."is_test_order" = false;--> statement-breakpoint
CREATE INDEX "webhook_events_failed_idx" ON "webhook_events" USING btree ("failed_at") WHERE "webhook_events"."status" = 'failed';--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_event_type_check" CHECK ("audit_events"."event_type" in ('ORDER_CREATED','ORDER_UPDATED','ORDER_CANCELLED'));--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" in ('received','processing','processed','failed'));
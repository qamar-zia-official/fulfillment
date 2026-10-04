CREATE TABLE "exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	CONSTRAINT "exceptions_type_check" CHECK ("exceptions"."type" in ('unroutable_incomplete_address', 'unroutable_no_warehouse', 'unroutable_insufficient_stock', 'inventory_shortfall', 'address_rejected_by_carrier', 'carrier_error', 'supplier_out_of_stock', 'payment_failed')),
	CONSTRAINT "exceptions_status_check" CHECK ("exceptions"."status" in ('open','resolved','ignored')),
	CONSTRAINT "exceptions_severity_check" CHECK ("exceptions"."severity" in ('blocking','warning')),
	CONSTRAINT "exceptions_resolution_audit_check" CHECK ("exceptions"."status" = 'open' or ("exceptions"."resolved_at" is not null and "exceptions"."resolved_by" is not null and "exceptions"."resolution_note" is not null))
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" text PRIMARY KEY NOT NULL,
	"warehouse_id" text NOT NULL,
	"sku" text NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reserved_within_on_hand_check" CHECK ("inventory"."reserved" <= "inventory"."on_hand"),
	CONSTRAINT "inventory_quantities_non_negative_check" CHECK ("inventory"."on_hand" >= 0 and "inventory"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "inventory_reservations_quantity_positive_check" CHECK ("inventory_reservations"."quantity" > 0),
	CONSTRAINT "inventory_reservations_status_check" CHECK ("inventory_reservations"."status" in ('active','released','committed'))
);
--> statement-breakpoint
CREATE TABLE "warehouse_routes" (
	"warehouse_id" text NOT NULL,
	"country_code" text NOT NULL,
	"priority" integer NOT NULL,
	CONSTRAINT "warehouse_routes_warehouse_id_country_code_pk" PRIMARY KEY("warehouse_id","country_code"),
	CONSTRAINT "warehouse_routes_priority_positive_check" CHECK ("warehouse_routes"."priority" >= 0),
	CONSTRAINT "warehouse_routes_country_code_format_check" CHECK ("warehouse_routes"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country_code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_country_code_format_check" CHECK ("warehouses"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "allocated_warehouse_id" text;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_routes" ADD CONSTRAINT "warehouse_routes_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exceptions_status_created_idx" ON "exceptions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "exceptions_order_idx" ON "exceptions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_warehouse_sku_unique" ON "inventory" USING btree ("warehouse_id","sku");--> statement-breakpoint
CREATE INDEX "inventory_sku_idx" ON "inventory" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_order_sku_active_unique" ON "inventory_reservations" USING btree ("order_id","sku") WHERE "inventory_reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "inventory_reservations_order_status_idx" ON "inventory_reservations" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX "inventory_reservations_warehouse_status_idx" ON "inventory_reservations" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "warehouse_routes_country_priority_idx" ON "warehouse_routes" USING btree ("country_code","priority","warehouse_id");--> statement-breakpoint
CREATE INDEX "orders_warehouse_status_idx" ON "orders" USING btree ("allocated_warehouse_id") WHERE "orders"."allocated_warehouse_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_lifecycle_check" CHECK ("orders"."status" in ('pending','allocated','picking','picked','packed','shipped','delivered','cancelled'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_allocated_requires_warehouse_check" CHECK ("orders"."status" <> 'allocated' or "orders"."allocated_warehouse_id" is not null);
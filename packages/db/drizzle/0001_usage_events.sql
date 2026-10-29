-- Usage ledger, partitioned by month. The worker creates each month's partition ahead of time
-- (ensure_usage_partition); the default partition catches anything that arrives early.
CREATE TABLE "usage_events" (
	"org_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"stream_id" text NOT NULL,
	"type" text NOT NULL,
	"req_id" text,
	"key_id" text,
	"provider" text,
	"route" text,
	"sku" text,
	"skus" text,
	"worst_micros" bigint,
	"cost_micros" bigint,
	"status" integer,
	"latency_ms" real,
	"session" text,
	"env" text,
	"agent_id" text,
	"underpriced" boolean DEFAULT false NOT NULL,
	"hash" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	PRIMARY KEY ("org_id", "ts", "stream_id")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
CREATE TABLE "usage_events_default" PARTITION OF "usage_events" DEFAULT;
--> statement-breakpoint
CREATE INDEX "usage_events_org_key_ts" ON "usage_events" ("org_id", "key_id", "ts");
--> statement-breakpoint
CREATE INDEX "usage_events_org_type_ts" ON "usage_events" ("org_id", "type", "ts");
--> statement-breakpoint
CREATE FUNCTION ensure_usage_partition(month_start date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	name text := 'usage_events_' || to_char(month_start, 'YYYYMM');
BEGIN
	IF to_regclass(name) IS NULL THEN
		EXECUTE format(
			'CREATE TABLE %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
			name, month_start, (month_start + interval '1 month')::date
		);
	END IF;
	RETURN name;
END $$;

CREATE TABLE "workspace_keys" (
	"workspace_id" text NOT NULL,
	"vendor" text NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_models" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"default_model" text,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_models" ADD CONSTRAINT "workspace_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_keys_vendor_idx" ON "workspace_keys" USING btree ("workspace_id","vendor");
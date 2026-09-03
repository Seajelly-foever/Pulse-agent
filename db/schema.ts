import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const audit = {
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
};

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), email: text("email").notNull(), displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"), feishuOpenId: text("feishu_open_id"), role: text("role").notNull().default("member"), ...audit,
}, (t) => [uniqueIndex("idx_users_email").on(t.email)]);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(), name: text("name").notNull(), slug: text("slug").notNull(),
  createdBy: text("created_by").references(() => users.id), ...audit,
}, (t) => [uniqueIndex("idx_workspaces_slug").on(t.slug)]);

export const workspaceMembers = sqliteTable("workspace_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("member"), ...audit,
}, (t) => [uniqueIndex("idx_workspace_members_unique").on(t.workspaceId, t.userId)]);

export const workspaceInvites = sqliteTable("workspace_invites", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  email: text("email").notNull(), role: text("role").notNull().default("member"), status: text("status").notNull().default("pending"),
  invitedBy: text("invited_by").references(() => users.id), ...audit,
}, (t) => [uniqueIndex("idx_workspace_invites_unique").on(t.workspaceId, t.email)]);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").references(() => workspaces.id), name: text("name").notNull(), summary: text("summary"), status: text("status").notNull().default("active"),
  health: text("health").notNull().default("healthy"), progress: integer("progress").notNull().default(0), ownerId: text("owner_id").references(() => users.id),
  expectedOutcome: text("expected_outcome"), targetDate: text("target_date"), configJson: text("config_json").notNull().default("{}"), ...audit,
});

export const updates = sqliteTable("project_updates", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id), authorId: text("author_id").references(() => users.id),
  source: text("source").notNull().default("web"), rawContent: text("raw_content"), summary: text("summary").notNull(), progressDelta: integer("progress_delta").default(0), ...audit,
});

export const metrics = sqliteTable("metrics", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id), name: text("name").notNull(),
  value: text("value").notNull(), target: text("target"), unit: text("unit"), status: text("status").notNull().default("normal"), measuredAt: text("measured_at").notNull(), ...audit,
});

export const risks = sqliteTable("risks", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => projects.id), title: text("title").notNull(),
  severity: text("severity").notNull(), status: text("status").notNull().default("open"), ownerId: text("owner_id").references(() => users.id), dueDate: text("due_date"), ...audit,
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").references(() => workspaces.id), projectId: text("project_id").references(() => projects.id), title: text("title").notNull(), url: text("url").notNull(),
  kind: text("kind").notNull(), createdBy: text("created_by").references(() => users.id), metadataJson: text("metadata_json").notNull().default("{}"), ...audit,
});

export const skillDefinitions = sqliteTable("skill_definitions", {
  id: text("id").primaryKey(), name: text("name").notNull(), description: text("description"), version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"), configJson: text("config_json").notNull().default("{}"), promptTemplate: text("prompt_template").notNull(), createdBy: text("created_by").references(() => users.id), ...audit,
});

export const reports = sqliteTable("reports", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").references(() => workspaces.id), type: text("type").notNull(), title: text("title").notNull(), content: text("content").notNull(),
  scopeJson: text("scope_json").notNull().default("{}"), generatedBy: text("generated_by").references(() => users.id), model: text("model"), ...audit,
});

export const integrations = sqliteTable("integrations", {
  id: text("id").primaryKey(), provider: text("provider").notNull(), status: text("status").notNull().default("inactive"),
  configJson: text("config_json").notNull().default("{}"), encryptedSecretRef: text("encrypted_secret_ref"), ...audit,
}, (t) => [uniqueIndex("idx_integrations_provider").on(t.provider)]);

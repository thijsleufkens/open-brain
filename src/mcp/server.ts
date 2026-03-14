/**
 * MCP Server — registers all MCP tools for AI clients.
 *
 * Tools (8 total):
 * - search_thoughts:      Semantic + FTS hybrid search with filters
 * - capture_thought:       Save a thought with embedding + async metadata
 * - list_recent_thoughts:  Paginated recent thoughts
 * - get_brain_stats:       Knowledge base statistics
 * - list_topics:           Topics ranked by frequency
 * - get_action_items:      Open/completed action items
 * - delete_thought:        Permanently remove a thought + metadata
 * - update_thought:        Edit content, re-embed, re-extract metadata
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ThoughtService } from "../services/thought.service.js";
import type { SearchService } from "../services/search.service.js";
import type { ThoughtRepository } from "../repositories/thought.repository.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";
import type { Logger } from "../utils/logger.js";

export interface McpDependencies {
  thoughtService: ThoughtService;
  searchService: SearchService;
  thoughtRepo: ThoughtRepository;
  metadataRepo: MetadataRepository;
  logger: Logger;
}

const sourceEnum = z.enum(["mcp", "telegram", "cli", "import"]);
const noteTypeEnum = z.enum(["idea", "meeting", "decision", "task", "reference", "journal", "other"]);
const periodEnum = z.enum(["week", "month", "quarter", "year", "all"]);

export function createMcpServer(deps: McpDependencies): McpServer {
  const { thoughtService, searchService, thoughtRepo, metadataRepo, logger } = deps;

  const server = new McpServer({ name: "open-brain", version: "0.1.0" });

  // search_thoughts
  server.tool(
    "search_thoughts",
    "Semantically search your personal knowledge base. Combines vector similarity with full-text keyword matching.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default: 10, max: 50)"),
      source: sourceEnum.optional().describe("Filter by capture source"),
      note_type: noteTypeEnum.optional().describe("Filter by note type"),
      topic: z.string().optional().describe("Filter by topic"),
      person: z.string().optional().describe("Filter by mentioned person"),
      date_from: z.string().optional().describe("ISO date, thoughts created on/after"),
      date_to: z.string().optional().describe("ISO date, thoughts created on/before"),
    },
    async (args) => {
      logger.debug({ tool: "search_thoughts" }, "Tool called");
      const result = await searchService.search({
        query: args.query,
        limit: args.limit,
        source: args.source,
        noteType: args.note_type,
        topic: args.topic,
        person: args.person,
        dateFrom: args.date_from,
        dateTo: args.date_to,
      });

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      const thoughts = result.value;
      if (thoughts.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching thoughts found." }] };
      }

      const text = thoughts.map((r, i) => {
        const t = r.thought;
        return `### ${i + 1}. [${t.noteType}] ${t.createdAt}\n**Source**: ${t.source} | **Match**: ${r.matchType} | **Score**: ${r.score.toFixed(4)}\n${t.content}`;
      }).join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: `Found ${thoughts.length} thought(s):\n\n${text}` }] };
    }
  );

  // capture_thought
  server.tool(
    "capture_thought",
    "Save a new thought to your personal knowledge base. It will be embedded for semantic search.",
    {
      content: z.string().describe("The thought to capture"),
      note_type: noteTypeEnum.optional().describe("Type of note (default: idea)"),
      source: sourceEnum.optional().describe("Override capture source (default: mcp)"),
    },
    async (args) => {
      logger.debug({ tool: "capture_thought" }, "Tool called");
      const result = await thoughtService.capture({
        content: args.content,
        noteType: args.note_type,
        source: args.source,
      });

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      const t = result.value;
      return {
        content: [{
          type: "text" as const,
          text: `Thought captured.\n**ID**: ${t.id}\n**Type**: ${t.noteType}\n**Source**: ${t.source}\n**Time**: ${t.createdAt}\n**Content**: ${t.content.slice(0, 200)}${t.content.length > 200 ? "..." : ""}`,
        }],
      };
    }
  );

  // list_recent_thoughts
  server.tool(
    "list_recent_thoughts",
    "List your most recently captured thoughts, ordered by creation time.",
    {
      limit: z.number().optional().describe("Number of thoughts (default: 20, max: 100)"),
      offset: z.number().optional().describe("Skip this many for pagination"),
      source: sourceEnum.optional().describe("Filter by source"),
      note_type: noteTypeEnum.optional().describe("Filter by note type"),
    },
    async (args) => {
      logger.debug({ tool: "list_recent_thoughts" }, "Tool called");
      const limit = Math.min(args.limit ?? 20, 100);
      const offset = args.offset ?? 0;

      const result = thoughtRepo.findRecent(limit, offset, {
        source: args.source,
        noteType: args.note_type,
      });

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      const thoughts = result.value;
      if (thoughts.length === 0) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const text = thoughts.map((t, i) => {
        return `### ${offset + i + 1}. [${t.noteType}] ${t.createdAt}\n**Source**: ${t.source} | **ID**: ${t.id}\n${t.content}`;
      }).join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: `Showing ${thoughts.length} thought(s) (offset: ${offset}):\n\n${text}` }] };
    }
  );

  // get_brain_stats
  server.tool(
    "get_brain_stats",
    "Get statistics about your knowledge base: total thoughts, by type, by source, and recent activity.",
    {
      period: periodEnum.optional().describe("Time period (default: month)"),
    },
    async (args) => {
      logger.debug({ tool: "get_brain_stats" }, "Tool called");
      const period = args.period ?? "month";
      const result = thoughtRepo.getStats(period);

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      const stats = result.value;
      const lines = [
        `## Brain Statistics`,
        `**Total thoughts**: ${stats.totalThoughts}`,
        "",
        "### By Source",
        ...Object.entries(stats.bySource).map(([s, c]) => `- ${s}: ${c}`),
        "",
        "### By Type",
        ...Object.entries(stats.byNoteType).map(([t, c]) => `- ${t}: ${c}`),
        "",
        `### Recent Activity (${period})`,
        ...stats.recentActivity.map((a) => `- ${a.date}: ${a.count} thought(s)`),
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  // list_topics
  server.tool(
    "list_topics",
    "List all topics in your knowledge base, ranked by frequency.",
    {
      limit: z.number().optional().describe("Number of topics (default: 30)"),
      period: periodEnum.optional().describe("Time period (default: all)"),
    },
    async (args) => {
      logger.debug({ tool: "list_topics" }, "Tool called");
      const result = metadataRepo.listTopics(args.limit ?? 30, args.period);

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      const topics = result.value;
      if (topics.length === 0) {
        return { content: [{ type: "text" as const, text: "No topics found yet." }] };
      }

      const text = topics.map((t, i) => `${i + 1}. **${t.topic}** (${t.count})`).join("\n");
      return { content: [{ type: "text" as const, text: `## Topics (${topics.length})\n\n${text}` }] };
    }
  );

  // get_action_items
  server.tool(
    "get_action_items",
    "List action items extracted from your thoughts.",
    {
      status: z.enum(["open", "completed", "all"]).optional().describe("Filter by status (default: open)"),
      limit: z.number().optional().describe("Max results (default: 20)"),
    },
    async (args) => {
      logger.debug({ tool: "get_action_items" }, "Tool called");
      const result = metadataRepo.listActions(args.status ?? "open", args.limit ?? 20);

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      const actions = result.value;
      if (actions.length === 0) {
        return { content: [{ type: "text" as const, text: "No action items found." }] };
      }

      const text = actions.map((a, i) => {
        const mark = a.completed ? "[x]" : "[ ]";
        const due = a.dueDate ? ` (due: ${a.dueDate})` : "";
        return `${i + 1}. ${mark} ${a.actionText}${due}`;
      }).join("\n");

      return { content: [{ type: "text" as const, text: `## Action Items (${actions.length})\n\n${text}` }] };
    }
  );

  // delete_thought
  server.tool(
    "delete_thought",
    "Permanently delete a thought and all its associated metadata (topics, people, actions, embedding).",
    {
      thought_id: z.string().describe("The ID of the thought to delete"),
    },
    async (args) => {
      logger.debug({ tool: "delete_thought" }, "Tool called");
      const result = thoughtService.delete(args.thought_id);

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      if (!result.value) {
        return { content: [{ type: "text" as const, text: `Thought not found: ${args.thought_id}` }], isError: true };
      }

      return { content: [{ type: "text" as const, text: `Thought ${args.thought_id} deleted successfully.` }] };
    }
  );

  // update_thought
  server.tool(
    "update_thought",
    "Update a thought's content. The embedding is re-generated and metadata extraction is re-triggered.",
    {
      thought_id: z.string().describe("The ID of the thought to update"),
      content: z.string().describe("The new content for the thought"),
    },
    async (args) => {
      logger.debug({ tool: "update_thought" }, "Tool called");
      const result = await thoughtService.update(args.thought_id, args.content);

      if (result.isErr()) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error.message}` }], isError: true };
      }

      const t = result.value;
      return {
        content: [{
          type: "text" as const,
          text: `Thought updated.\n**ID**: ${t.id}\n**Updated**: ${t.updatedAt}\n**Content**: ${t.content.slice(0, 200)}${t.content.length > 200 ? "..." : ""}`,
        }],
      };
    }
  );

  logger.info("MCP server created with 8 tools");
  return server;
}

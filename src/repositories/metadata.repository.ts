/**
 * MetadataRepository — CRUD for extracted metadata (topics, people, actions).
 *
 * Metadata is extracted asynchronously by Gemini Flash and stored in
 * normalized tables linked to thoughts via thought_id foreign keys.
 * Supports querying by topic, person, action status, and time period.
 */
import type Database from "better-sqlite3";
import { ok, err, Result } from "neverthrow";
import { DatabaseError } from "../types/errors.js";

export interface TopicCount {
  topic: string;
  count: number;
}

export interface ActionItem {
  id: number;
  thoughtId: string;
  actionText: string;
  dueDate: string | null;
  completed: boolean;
  createdAt: string;
}

export class MetadataRepository {
  private readonly insertTopicStmt;
  private readonly insertPersonStmt;
  private readonly insertActionStmt;
  private readonly findTopicsByThoughtStmt;
  private readonly findPeopleByThoughtStmt;
  private readonly findActionsByThoughtStmt;

  constructor(private readonly db: Database.Database) {
    this.insertTopicStmt = db.prepare(
      "INSERT INTO topics (thought_id, topic) VALUES (?, ?)"
    );
    this.insertPersonStmt = db.prepare(
      "INSERT INTO people (thought_id, person_name) VALUES (?, ?)"
    );
    this.insertActionStmt = db.prepare(
      "INSERT INTO actions (thought_id, action_text, due_date) VALUES (?, ?, ?)"
    );
    this.findTopicsByThoughtStmt = db.prepare(
      "SELECT topic FROM topics WHERE thought_id = ?"
    );
    this.findPeopleByThoughtStmt = db.prepare(
      "SELECT person_name FROM people WHERE thought_id = ?"
    );
    this.findActionsByThoughtStmt = db.prepare(
      "SELECT * FROM actions WHERE thought_id = ?"
    );
  }

  insertTopics(
    thoughtId: string,
    topics: string[]
  ): Result<void, DatabaseError> {
    try {
      const tx = this.db.transaction(() => {
        for (const topic of topics) {
          this.insertTopicStmt.run(thoughtId, topic.toLowerCase().trim());
        }
      });
      tx();
      return ok(undefined);
    } catch (error) {
      return err(new DatabaseError("Failed to insert topics", error));
    }
  }

  insertPeople(
    thoughtId: string,
    people: string[]
  ): Result<void, DatabaseError> {
    try {
      const tx = this.db.transaction(() => {
        for (const person of people) {
          this.insertPersonStmt.run(thoughtId, person.trim());
        }
      });
      tx();
      return ok(undefined);
    } catch (error) {
      return err(new DatabaseError("Failed to insert people", error));
    }
  }

  insertActions(
    thoughtId: string,
    actions: { text: string; dueDate?: string }[]
  ): Result<void, DatabaseError> {
    try {
      const tx = this.db.transaction(() => {
        for (const action of actions) {
          this.insertActionStmt.run(
            thoughtId,
            action.text,
            action.dueDate ?? null
          );
        }
      });
      tx();
      return ok(undefined);
    } catch (error) {
      return err(new DatabaseError("Failed to insert actions", error));
    }
  }

  listTopics(
    limit: number = 30,
    period?: string
  ): Result<TopicCount[], DatabaseError> {
    try {
      let dateFilter = "";
      if (period === "week") dateFilter = "AND t.created_at >= date('now', '-7 days')";
      else if (period === "month") dateFilter = "AND t.created_at >= date('now', '-30 days')";
      else if (period === "quarter") dateFilter = "AND t.created_at >= date('now', '-90 days')";
      else if (period === "year") dateFilter = "AND t.created_at >= date('now', '-365 days')";

      const rows = this.db
        .prepare(
          `SELECT tp.topic, COUNT(*) as count
           FROM topics tp
           JOIN thoughts t ON tp.thought_id = t.id
           WHERE 1=1 ${dateFilter}
           GROUP BY tp.topic
           ORDER BY count DESC
           LIMIT ?`
        )
        .all(limit) as { topic: string; count: number }[];
      return ok(rows);
    } catch (error) {
      return err(new DatabaseError("Failed to list topics", error));
    }
  }

  listActions(
    status: "open" | "completed" | "all" = "open",
    limit: number = 20
  ): Result<ActionItem[], DatabaseError> {
    try {
      let filter = "";
      if (status === "open") filter = "WHERE a.completed = 0";
      else if (status === "completed") filter = "WHERE a.completed = 1";

      const rows = this.db
        .prepare(
          `SELECT a.id, a.thought_id, a.action_text, a.due_date, a.completed, a.created_at
           FROM actions a
           ${filter}
           ORDER BY a.created_at DESC
           LIMIT ?`
        )
        .all(limit) as {
        id: number;
        thought_id: string;
        action_text: string;
        due_date: string | null;
        completed: number;
        created_at: string;
      }[];

      return ok(
        rows.map((r) => ({
          id: r.id,
          thoughtId: r.thought_id,
          actionText: r.action_text,
          dueDate: r.due_date,
          completed: r.completed === 1,
          createdAt: r.created_at,
        }))
      );
    } catch (error) {
      return err(new DatabaseError("Failed to list actions", error));
    }
  }

  findThoughtIdsByTopic(topic: string): Result<string[], DatabaseError> {
    try {
      const rows = this.db
        .prepare("SELECT thought_id FROM topics WHERE topic = ?")
        .all(topic.toLowerCase().trim()) as { thought_id: string }[];
      return ok(rows.map((r) => r.thought_id));
    } catch (error) {
      return err(new DatabaseError("Failed to find thoughts by topic", error));
    }
  }

  findThoughtIdsByPerson(person: string): Result<string[], DatabaseError> {
    try {
      // Escape LIKE wildcards to prevent pattern injection
      const escaped = person.replace(/[%_\\]/g, "\\$&");
      const rows = this.db
        .prepare(
          "SELECT thought_id FROM people WHERE person_name LIKE ? ESCAPE '\\'"
        )
        .all(`%${escaped}%`) as { thought_id: string }[];
      return ok(rows.map((r) => r.thought_id));
    } catch (error) {
      return err(
        new DatabaseError("Failed to find thoughts by person", error)
      );
    }
  }

  deleteByThoughtId(thoughtId: string): Result<void, DatabaseError> {
    try {
      const tx = this.db.transaction(() => {
        this.db.prepare("DELETE FROM topics WHERE thought_id = ?").run(thoughtId);
        this.db.prepare("DELETE FROM people WHERE thought_id = ?").run(thoughtId);
        this.db.prepare("DELETE FROM actions WHERE thought_id = ?").run(thoughtId);
      });
      tx();
      return ok(undefined);
    } catch (error) {
      return err(new DatabaseError("Failed to delete metadata", error));
    }
  }
}

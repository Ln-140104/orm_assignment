import { Router } from "express";
import { db } from "./db.js";

export const router = Router();

// GET /api/todos?completed=true|false
router.get("/todos", async (req, res) => {
  const { completed } = req.query;

  const where =
    completed === "true" ? { completed: true } : completed === "false" ? { completed: false } : undefined;

  const todos = await db.todo.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  res.json(todos);
});

// POST /api/todos { title: string }
router.post("/todos", async (req, res) => {
  const { title } = req.body ?? {};
  if (typeof title !== "string" || title.trim().length === 0) {
    return res.status(400).json({ error: "title is required" });
  }

  const todo = await db.todo.create({ title: title.trim() });
  res.status(201).json(todo);
});

// PATCH /api/todos/:id { completed?: boolean, title?: string }
router.patch("/todos/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  const { completed, title } = req.body ?? {};
  const data: { completed?: boolean; title?: string } = {};
  if (typeof completed === "boolean") data.completed = completed;
  if (typeof title === "string" && title.trim().length > 0) data.title = title.trim();

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "no valid fields to update" });
  }

  const [updated] = await db.todo.update({ where: { id }, data });
  if (!updated) return res.status(404).json({ error: "todo not found" });
  res.json(updated);
});

// DELETE /api/todos/:id
router.delete("/todos/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });

  const [deleted] = await db.todo.delete({ where: { id } });
  if (!deleted) return res.status(404).json({ error: "todo not found" });
  res.status(204).send();
});

// GET /api/todos/stats — small demo of count()
router.get("/todos/stats", async (_req, res) => {
  const [total, completed] = await Promise.all([
    db.todo.count(),
    db.todo.count({ where: { completed: true } }),
  ]);
  res.json({ total, completed, remaining: total - completed });
});

// Note: this imports the ORM exactly as any consumer of the published npm
// package would — there are no relative "../../packages/light-orm/src/..."
// imports anywhere in this app.
import { defineModel, id, string, boolean, date } from "@lakku/light-orm";

export const Todo = defineModel("todo", {
  id: id(),
  title: string(),
  completed: boolean({ default: false }),
  createdAt: date({ default: new Date() }),
});

export const models = { todo: Todo };

const listEl = document.getElementById("todo-list");
const formEl = document.getElementById("create-form");
const inputEl = document.getElementById("title-input");
const statsEl = document.getElementById("stats");
const filterButtons = document.querySelectorAll(".filter");

let currentFilter = "all"; // all | active | completed

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function queryForFilter(filter) {
  if (filter === "active") return "?completed=false";
  if (filter === "completed") return "?completed=true";
  return "";
}

async function loadTodos() {
  const [todos, stats] = await Promise.all([
    api(`/todos${queryForFilter(currentFilter)}`),
    api("/todos/stats"),
  ]);
  renderTodos(todos);
  renderStats(stats);
}

function renderStats({ total, remaining }) {
  if (total === 0) {
    statsEl.textContent = "nothing here yet";
    return;
  }
  statsEl.textContent = `${remaining} of ${total} remaining`;
}

function renderTodos(todos) {
  listEl.innerHTML = "";

  if (todos.length === 0) {
    const empty = document.createElement("li");
    empty.className = "todo-list__empty";
    empty.textContent =
      currentFilter === "completed" ? "No completed todos yet." : "Nothing here — add your first todo above.";
    listEl.appendChild(empty);
    return;
  }

  for (const todo of todos) {
    const li = document.createElement("li");
    li.className = `todo-item${todo.completed ? " todo-item--completed" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-item__checkbox";
    checkbox.checked = todo.completed;
    checkbox.setAttribute("aria-label", `Mark "${todo.title}" as ${todo.completed ? "active" : "completed"}`);
    checkbox.addEventListener("change", () => toggleCompleted(todo.id, checkbox.checked));

    const title = document.createElement("span");
    title.className = "todo-item__title";
    title.textContent = todo.title;

    const del = document.createElement("button");
    del.className = "todo-item__delete";
    del.textContent = "Remove";
    del.addEventListener("click", () => deleteTodo(todo.id));

    li.append(checkbox, title, del);
    listEl.appendChild(li);
  }
}

async function toggleCompleted(id, completed) {
  await api(`/todos/${id}`, { method: "PATCH", body: JSON.stringify({ completed }) });
  loadTodos();
}

async function deleteTodo(id) {
  await api(`/todos/${id}`, { method: "DELETE" });
  loadTodos();
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = inputEl.value.trim();
  if (!title) return;
  inputEl.value = "";
  await api("/todos", { method: "POST", body: JSON.stringify({ title }) });
  loadTodos();
});

for (const btn of filterButtons) {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.filter;
    for (const b of filterButtons) b.setAttribute("aria-selected", String(b === btn));
    loadTodos();
  });
}

loadTodos().catch((err) => {
  statsEl.textContent = `Failed to load: ${err.message}`;
});

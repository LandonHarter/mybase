import { DEFAULT_API_URL, type Project } from "@mybase/shared";

const API_URL = DEFAULT_API_URL;

const list = document.querySelector<HTMLUListElement>("#projects")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const form = document.querySelector<HTMLFormElement>("#create")!;

async function refresh() {
  try {
    const projects: Project[] = await fetch(`${API_URL}/projects`).then((r) => r.json());
    list.replaceChildren(
      ...projects.map((p) => {
        const li = document.createElement("li");
        li.textContent = `${p.name} — ${new Date(p.createdAt).toLocaleString()}`;
        return li;
      }),
    );
    status.textContent = projects.length ? "" : "No projects yet.";
  } catch {
    status.textContent = `Cannot reach API at ${API_URL}`;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = new FormData(form).get("name") as string;
  const res = await fetch(`${API_URL}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    status.textContent = ((await res.json()) as { error: string }).error;
    return;
  }
  form.reset();
  await refresh();
});

refresh();

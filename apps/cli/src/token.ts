// `mybase token …`: API keys for apps, scripts, and CI, each with its own permissions.
import { KEY_RESOURCES, type ApiToken, type CreateApiTokenRequest, type CreateApiTokenResponse, type KeyPermission } from "@mybase/shared";
import { api } from "./api";
import { flagString, need, parseArgs } from "./cron";
import { print } from "./output";

export const tokenUsage = `  token list                     List API keys and what they may do
  token create <name> (--perm <p,…> [--project <name,…>] | --admin)
                                 Make a key and print it once. <p>: <resource>:read|write,
                                 resources: ${KEY_RESOURCES.map((r) => r.id).join(", ")}
  token update <id> [--name <n>] [--perm <p,…>] [--project <name,…>|--all-projects] [--admin]
  token delete <id>              Revoke a key (it stops working now)`;

const list = (value: string | undefined) => value?.split(",").map((v) => v.trim()).filter(Boolean);

export const describeGrant = (t: Pick<ApiToken, "permissions" | "projects">) =>
  `${t.permissions.join(",")} on ${t.projects ? t.projects.join(",") : "all projects"}`;

/** `--perm`/`--admin` and `--project`/`--all-projects` as a request body (only what was given). */
function grantFlags(flags: Map<string, string | true>): Omit<CreateApiTokenRequest, "name"> {
  const body: Omit<CreateApiTokenRequest, "name"> = {};
  if (flags.has("admin")) {
    body.permissions = ["admin"];
    body.projects = null;
  } else if (flags.has("perm")) body.permissions = list(flagString(flags, "perm")) as KeyPermission[];
  if (flags.has("all-projects")) body.projects = null;
  else if (flags.has("project")) body.projects = list(flagString(flags, "project")) ?? null;
  return body;
}

/** Handles `mybase token <sub> …`. False when `sub` isn't a token command. */
export async function token(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [first] = positional;
  switch (sub) {
    case "list": {
      const tokens = await api<ApiToken[]>("/auth/tokens");
      print(tokens, () => {
        if (tokens.length === 0) console.log("No API keys.");
        for (const t of tokens) console.log([t.id, t.name, describeGrant(t), `last used ${t.lastUsedAt ?? "never"}`].join("\t"));
      });
      return true;
    }
    case "create": {
      const name = need(first, "key name");
      const grant = grantFlags(flags);
      if (!grant.permissions) throw new Error("say what the key may do: --perm <resource>:read|write,… or --admin");
      const created = await api<CreateApiTokenResponse>("/auth/tokens", { method: "POST", body: JSON.stringify({ name, ...grant }) });
      print(created, () => {
        console.log(`Created "${created.name}" (${describeGrant(created)})\n`);
        console.log(`  MYBASE_API_KEY=${created.token}\n`);
        console.log("Save it now. It isn't stored, so it can't be shown again.");
      });
      return true;
    }
    case "update": {
      const id = need(first, "key id");
      const body = { ...grantFlags(flags), ...(flags.has("name") ? { name: flagString(flags, "name") } : {}) };
      if (Object.keys(body).length === 0) throw new Error("nothing to change: pass --name, --perm, --project, --all-projects, or --admin");
      const updated = await api<ApiToken>(`/auth/tokens/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
      print(updated, () => console.log(`Updated "${updated.name}" (${describeGrant(updated)})`));
      return true;
    }
    case "delete": {
      const id = need(first, "key id");
      await api(`/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      print({ revoked: id }, () => console.log("Revoked."));
      return true;
    }
  }
  return false;
}

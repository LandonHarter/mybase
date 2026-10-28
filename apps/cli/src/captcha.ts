// `mybase captcha …`: self-hosted proof-of-work bot checks for a project's forms.
import type { CaptchaSettings } from "@mybase/shared";
import { api } from "./api";
import { need, parseArgs } from "./cron";
import { confirm, print } from "./output";
import { enableService, printLinked } from "./service-enable";

export const captchaUsage = `  captcha enable <project>       Turn on the captcha and print the script tag and secret
  captcha key <project> [--rotate]  Show (or replace) the secret your server checks tokens with
  captcha difficulty <project> <n>  Numbers a browser may try per challenge (1000–1000000; default 50000)
  captcha disable <project> [--yes]  Turn it off (forms that need it stop accepting submissions)`;

const base = (project: string) => `/projects/${encodeURIComponent(project)}/captcha`;

function printSettings(project: string, s: CaptchaSettings) {
  console.log("Script tag (forms marked data-mybase-captcha get a hidden mybase-captcha field):");
  console.log(`  <script defer src="${s.scriptUrl}" data-project="${project}"></script>\n`);
  console.log(`  secret      ${s.secretKey}  (server-side only: MYBASE_CAPTCHA_SECRET)`);
  console.log(`  difficulty  ${s.maxNumber.toLocaleString()} numbers per challenge`);
  console.log(`  siteverify  ${s.siteVerifyUrl}  (Turnstile-compatible; Better Auth: mybaseCaptcha())`);
}

/** Handles `mybase captcha <sub> …`. False when `sub` isn't a captcha command. */
export async function captcha(sub: string, args: string[]): Promise<boolean> {
  const { positional, flags } = parseArgs(args);
  const [project, value] = positional;
  switch (sub) {
    case "enable": {
      const p = need(project, "project name");
      const { linked } = await enableService(p, "captcha", flags);
      const s = await api<CaptchaSettings>(base(p));
      print({ enabled: "captcha", project: p, linked, ...s }, () => {
        console.log(`Captcha enabled for "${p}"\n`);
        printSettings(p, s);
        printLinked(p, linked, flags);
      });
      return true;
    }
    case "key": {
      const p = need(project, "project name");
      const s = flags.has("rotate") ? await api<CaptchaSettings>(`${base(p)}/secret/rotate`, { method: "POST" }) : await api<CaptchaSettings>(base(p));
      print(s, () => {
        if (flags.has("rotate")) console.log("Rotated. The old secret stops working now.\n");
        printSettings(p, s);
      });
      return true;
    }
    case "difficulty": {
      const p = need(project, "project name");
      const n = Number(need(value, "a number"));
      const s = await api<CaptchaSettings>(base(p), { method: "PATCH", body: JSON.stringify({ maxNumber: n }) });
      print(s, () => console.log(`Challenges now take up to ${s.maxNumber.toLocaleString()} tries.`));
      return true;
    }
    case "disable": {
      const p = need(project, "project name");
      confirm(args.includes("--yes"), `Forms on "${p}" that check the captcha will refuse every submission until you remove the check.`, p, "the project name");
      await api(`/projects/${encodeURIComponent(p)}/services/captcha`, { method: "DELETE" });
      print({ disabled: "captcha", project: p }, () => console.log(`Captcha disabled for "${p}"`));
      return true;
    }
  }
  return false;
}

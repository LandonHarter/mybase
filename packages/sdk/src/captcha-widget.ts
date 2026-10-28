// The script-tag build of the captcha, served by mybase at /captcha.js:
//
//   <script defer src="https://mybase.example.com/captcha.js" data-project="shop"></script>
//   <form data-mybase-captcha> … <button>Sign up</button> </form>
//
// On submit, a form marked `data-mybase-captcha` waits while the browser solves a challenge,
// then submits with a hidden `mybase-captcha` field holding the token. An element with class
// `mybase-captcha-status` inside the form shows progress. For fetch-based forms (Better Auth's
// client), call `await mybase.captcha.solve()` and send the token in `x-captcha-response`.
// Optional: data-api (default: where the script came from).
// `window.mybase` is declared in analytics-script.ts (both scripts share it).
import { solveCaptcha } from "./captcha";

const script = document.currentScript as HTMLScriptElement | null;
const data = script?.dataset ?? {};
const FIELD = "mybase-captcha";

if (!data.project) {
  console.warn("mybase captcha: add data-project to the script tag");
} else {
  const apiUrl = data.api || new URL(script!.src, location.href).origin;
  const project = data.project;
  const solve = () => solveCaptcha({ apiUrl, project });
  window.mybase = { ...window.mybase, captcha: { solve } };

  const status = (form: HTMLFormElement, text: string) => {
    const el = form.querySelector<HTMLElement>(".mybase-captcha-status");
    if (el) el.textContent = text;
  };

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-mybase-captcha")) return;
      // Already solved: this is the resubmit below.
      if (form.dataset.mybaseCaptchaReady === "1") {
        delete form.dataset.mybaseCaptchaReady;
        return;
      }
      // Hold the submit (and the page's own submit handlers) until the token is in the form.
      event.preventDefault();
      event.stopImmediatePropagation();
      const submitter = (event as SubmitEvent).submitter;
      status(form, "Checking you're not a bot…");
      solve()
        .then((token) => {
          let input = form.querySelector<HTMLInputElement>(`input[name="${FIELD}"]`);
          if (!input) {
            input = document.createElement("input");
            input.type = "hidden";
            input.name = FIELD;
            form.append(input);
          }
          input.value = token;
          status(form, "");
          form.dataset.mybaseCaptchaReady = "1";
          form.requestSubmit(submitter instanceof HTMLElement ? (submitter as HTMLButtonElement) : undefined);
        })
        .catch((err: unknown) => {
          console.warn("mybase captcha:", err);
          status(form, "Couldn't check this form. Try again.");
        });
    },
    true,
  );
}

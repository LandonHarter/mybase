// Renders a real React Email template the way `mybase email sync` does. The template lives in a
// temp dir inside apps/dashboard so react + @react-email/* resolve from the dashboard's install.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderTemplates } from "./email";

const dir = mkdtempSync(join(resolve(import.meta.dir, "../../dashboard"), ".email-render-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("headings keep {{placeholders}} lowercase in the text part", async () => {
  writeFileSync(
    join(dir, "welcome.tsx"),
    `import { Heading, Html, Text } from "@react-email/components";
export const subject = "Welcome, {{name}}";
export const PreviewProps = { name: "Ann" };
export default function Welcome({ name }: { name: string }) {
  return <Html><Heading>Hi {name}</Heading><Text>Thanks for joining.</Text></Html>;
}
`,
  );
  const [t] = await renderTemplates(dir);
  expect(t!.text).toContain("Hi {{name}}");
  expect(t!.text).not.toContain("{{NAME}}");
  expect(t!.variables).toEqual([{ name: "name", sample: "Ann" }]);
});

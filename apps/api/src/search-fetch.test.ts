import { describe, expect, test } from "bun:test";
import { BadRequestError } from "./errors";
import { checkUrl, htmlToMarkdown, isPublicIp } from "./search-fetch";

describe("isPublicIp", () => {
  test.each([
    "0.0.0.0",
    "127.0.0.1",
    "127.8.8.8",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.5",
    "100.64.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "fc00::1",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "not an ip",
  ])("%s is not public", (ip) => expect(isPublicIp(ip)).toBe(false));

  test.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"])(
    "%s is public",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );
});

describe("checkUrl", () => {
  test.each([
    "ftp://example.com/",
    "file:///etc/passwd",
    "not a url",
    "http://user:pass@example.com/",
    "http://127.0.0.1:4000/health",
    "http://2130706433/",
    "http://[::1]/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
  ])("refuses %s", async (url) => {
    await expect(checkUrl(url)).rejects.toBeInstanceOf(BadRequestError);
  });

  test("allows a public IP and drops the fragment", async () => {
    expect((await checkUrl("https://1.1.1.1/a?b=1#c")).href).toBe("https://1.1.1.1/a?b=1");
  });
});

describe("htmlToMarkdown", () => {
  const article = `<p>${"Bun ships a fast Postgres client built into the runtime. ".repeat(8)}</p>`;
  const html = `<!doctype html><html><head><title>Bun SQL</title></head><body>
    <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
    <article>
      <h1>Bun SQL <a href="#top">#</a></h1>
      ${article}
      <p>See <a href="/docs/sql">the docs</a> and <a href="https://example.com/x_(y)">this</a>.</p>
      <p><a href="/img"><img src="/logo.png" alt="logo"></a></p>
      <pre><code>const rows = await sql\`select 1\`;</code></pre>
      <script>alert(1)</script>
    </article>
    <footer>Copyright</footer>
  </body></html>`;

  test("keeps the main content as markdown", () => {
    const { title, markdown } = htmlToMarkdown(html, "https://bun.test/blog/sql");
    expect(title).toBe("Bun SQL");
    expect(markdown).toContain("Bun ships a fast Postgres client");
    expect(markdown).toContain("[the docs](https://bun.test/docs/sql)");
    expect(markdown).toContain("[this](https://example.com/x_\\(y\\))");
    expect(markdown).toContain("```\nconst rows = await sql`select 1`;\n```");
  });

  test("drops navigation, scripts, images, and empty or anchor links", () => {
    const { markdown } = htmlToMarkdown(html, "https://bun.test/blog/sql");
    expect(markdown).not.toContain("Copyright");
    expect(markdown).not.toContain("alert(1)");
    expect(markdown).not.toContain("logo");
    expect(markdown).not.toContain("](https://bun.test/img)");
    expect(markdown).not.toContain("[#]");
  });

  test("falls back to the page body when there's no article", () => {
    const { title, markdown } = htmlToMarkdown("<title>Tiny</title><nav>Menu</nav><main><p>Hello <b>there</b></p></main>", "https://t.test/");
    expect(title).toBe("Tiny");
    expect(markdown).toBe("Hello **there**");
  });
});

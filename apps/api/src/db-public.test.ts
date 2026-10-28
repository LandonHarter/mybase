import { expect, test } from "bun:test";
import { checkCertificate, parseTrace, pgHba, readConfig, replaceableHba } from "./db-public";

test("pg_hba: LAN as before, internet only for project roles over TLS, then reject", () => {
  expect(pgHba(false)).not.toContain("hostssl");
  const rules = pgHba(true)
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/));
  const internet = rules.filter((r) => r[3] === "0.0.0.0/0" || r[3] === "::/0");
  expect(internet).toHaveLength(2);
  for (const r of internet) expect(r.slice(0, 3)).toEqual(["hostssl", "sameuser", "+mybase_project"]);
  expect(rules.at(-1)).toEqual(["host", "all", "all", "all", "reject"]);
  expect(rules.some((r) => r[3] === "192.168.0.0/16" && r[4] === "scram-sha-256")).toBe(true);
  // Nothing before the internet lines may match a public address.
  expect(rules.some((r) => r[0] !== "local" && r[3] === "all" && r[4] !== "reject")).toBe(false);
});

test("only the image default or our own pg_hba gets replaced", () => {
  expect(replaceableHba(pgHba(false))).toBe(true);
  expect(replaceableHba("local all all trust\nhost all all 127.0.0.1/32 trust\n\nhost all all all scram-sha-256\n")).toBe(true);
  expect(replaceableHba("hostssl all bob 1.2.3.4/32 cert\n")).toBe(false);
});

test("readConfig", () => {
  expect(readConfig({}).enabled).toBe(false);
  expect(readConfig({ MYBASE_DB_PUBLIC: "on", MYBASE_DB_PUBLIC_HOST: "localhost", MYBASE_DNS_TOKEN: "t" }).problem).toContain("MYBASE_DB_PUBLIC_HOST");
  expect(readConfig({ MYBASE_DB_PUBLIC: "on", MYBASE_DB_PUBLIC_HOST: "db.example.com" }).problem).toContain("MYBASE_DNS_TOKEN");
  expect(readConfig({ MYBASE_DB_PUBLIC: "1", MYBASE_DB_PUBLIC_HOST: "DB.example.com", MYBASE_DNS_TOKEN: "t", MYBASE_ACME_STAGING: "true" }).config).toEqual({
    host: "db.example.com",
    token: "t",
    email: undefined,
    staging: true,
  });
});

test("parseTrace takes only IPv4", () => {
  expect(parseTrace("fl=1\nip=203.0.113.7\nts=1\n")).toBe("203.0.113.7");
  expect(parseTrace("ip=2001:db8::1\n")).toBeNull();
  expect(parseTrace("ip=999.1.1.1\n")).toBeNull();
  expect(parseTrace("nothing")).toBeNull();
});

const openssl = (args: string) => Bun.spawnSync(["sh", "-c", `${args} 2>/dev/null`]).stdout.toString();

test.skipIf(!Bun.which("openssl"))("checkCertificate", () => {
  const dir = openssl("mktemp -d").trim();
  openssl(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 30 -subj /CN=db.example.com -addext subjectAltName=DNS:db.example.com`,
  );
  openssl(`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ${dir}/other.pem`);
  const cert = openssl(`cat ${dir}/c.pem`);
  const key = openssl(`cat ${dir}/k.pem`);
  expect(checkCertificate(cert, key, "db.example.com").getTime()).toBeGreaterThan(Date.now());
  expect(() => checkCertificate(cert, key, "other.example.com")).toThrow("isn't for");
  expect(() => checkCertificate(cert, openssl(`cat ${dir}/other.pem`), "db.example.com")).toThrow("don't match");
  expect(() => checkCertificate(cert, key, "db.example.com", Date.now() + 365 * 86_400_000)).toThrow("expired");
  openssl(`rm -r ${dir}`);
});

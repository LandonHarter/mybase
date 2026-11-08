import { describe, expect, test } from "bun:test";
import type { Column } from "@mybase/shared";
import { rowQuerySql } from "./tables";

const cols: Column[] = [
  { name: "id", type: "integer", nullable: false, default: null, primaryKey: true },
  { name: "name", type: "text", nullable: true, default: null, primaryKey: false },
  { name: "total", type: "numeric(10,2)", nullable: false, default: "0", primaryKey: false },
];

describe("rowQuerySql", () => {
  test("parameterizes values and casts to the column type", () => {
    const q = rowQuerySql(cols, { filters: [{ column: "total", op: "gte", value: "10" }, { column: "name", op: "contains", value: "a%b" }] }, 3);
    expect(q.where).toBe(`where t."total" >= $3::numeric(10,2) and t."name"::text ilike $4`);
    expect(q.values).toEqual(["10", "%a\\%b%"]);
  });

  test("sorts with the primary key as a tiebreak", () => {
    expect(rowQuerySql(cols, { sort: { column: "name", desc: true } }, 1).order).toBe(`order by t."name" desc nulls last, t."id"`);
    expect(rowQuerySql(cols, {}, 1).order).toBe(`order by t."id"`);
  });

  test("null checks take no value", () => {
    const q = rowQuerySql(cols, { filters: [{ column: "name", op: "null" }] }, 1);
    expect(q.where).toBe(`where t."name" is null`);
    expect(q.values).toEqual([]);
  });

  test("refuses unknown columns and operators", () => {
    expect(() => rowQuerySql(cols, { filters: [{ column: "nope", op: "eq", value: "1" }] }, 1)).toThrow();
    expect(() => rowQuerySql(cols, { filters: [{ column: "id", op: "drop" as never, value: "1" }] }, 1)).toThrow();
    expect(() => rowQuerySql(cols, { sort: { column: 'x"; drop', desc: false } }, 1)).toThrow();
  });
});

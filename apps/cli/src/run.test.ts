import { describe, expect, test } from "bun:test";
import { ownArgs, splitRunArgs } from "./output";

describe("splitRunArgs", () => {
  test("after --", () => expect(splitRunArgs(["-e", "prod", "--", "bun", "--json"])).toEqual({ options: ["-e", "prod"], command: ["bun", "--json"] }));
  test("from the first non-option", () =>
    expect(splitRunArgs(["-p", "shop", "--preserve-env", "node", "-e", "x"])).toEqual({ options: ["-p", "shop", "--preserve-env"], command: ["node", "-e", "x"] }));
  test("a -- inside the command stays", () =>
    expect(splitRunArgs(["npm", "test", "--", "--watch"])).toEqual({ options: [], command: ["npm", "test", "--", "--watch"] }));
  test("no options", () => expect(splitRunArgs(["make", "dev"])).toEqual({ options: [], command: ["make", "dev"] }));
});

describe("ownArgs", () => {
  test("mybase run keeps the command's flags", () => expect(ownArgs(["run", "--json", "-e", "dev", "tool", "--json"])).toEqual(["run", "--json", "-e", "dev"]));
  test("other commands stop at --", () => expect(ownArgs(["secrets", "list", "--json", "--", "x"])).toEqual(["secrets", "list", "--json"]));
});

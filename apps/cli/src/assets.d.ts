// Files the CLI bundles as text (`import x from "…" with { type: "text" }`).
declare module "*.yml" {
  const text: string;
  export default text;
}

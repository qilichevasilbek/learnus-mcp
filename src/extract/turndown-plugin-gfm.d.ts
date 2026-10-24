/**
 * `turndown-plugin-gfm` ships no types and has no @types package. It is the
 * only source of real Markdown pipe tables in the extraction pipeline, so it
 * is worth this six-line declaration rather than dropping table support.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}

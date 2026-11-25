/**
 * pi-obs — extension entry (jiti shim).
 *
 * pi's auto-discovery and `pi -e` load `<extension-dir>/index.ts`;
 * the implementation lives in `src/` (SPECS: Artifact structure).
 * This shim is the stable entry — everything else can move.
 */

export * from "./src/index.ts";
export { default } from "./src/index.ts";

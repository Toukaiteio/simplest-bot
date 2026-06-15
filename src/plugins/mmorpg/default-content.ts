/**
 * Backward-compatibility layer.
 *
 * All built-in MMORPG content now lives in the `data/` module directory.
 * This file simply re-exports the aggregated content so that existing
 * imports (`import { DEFAULT_MMORPG_CONTENT } from "./default-content.js"`)
 * continue to work without modification.
 */
export { DEFAULT_MMORPG_CONTENT } from "./data/index.js";

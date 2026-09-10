/**
 * Must be imported before any module that calls `resolveApiServerBaseUrl()` at load time
 * (see `main.ts` import order).
 */
import { applyApiBaseQueryParam } from "./serverOrigin";

applyApiBaseQueryParam();

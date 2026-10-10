/**
 * @fileoverview
 * See `types.ts` for context on these symbols.
 */

import { Symbol_for } from "@/shared/snapshot";

export const SCRAMJETCLIENTNAME = "scramjet client global";
export const SCRAMJETCLIENT = Symbol_for(SCRAMJETCLIENTNAME);
/** key of the message that hands a new worker its transport port (a string: symbols don't survive postMessage) */
export const WORKERTRANSPORT = "$scramjet$transport";

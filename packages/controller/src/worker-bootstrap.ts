// the scramjet core bundle has to be loaded before the controller code that imports it, and
// imports run in order, so this module comes first in worker.ts
declare function importScripts(...urls: string[]): void;
importScripts(new URL(location.href).searchParams.get("scramjet")!);

export * from "./engine-core.js";

import type { EngineParams } from "./engine-core.js";

export interface SnakeParams extends EngineParams {}

export declare const DEFAULT_SNAKE_PARAMS: SnakeParams;

export declare function snakePicks(slot: number, teams: number, rounds?: number): number[];

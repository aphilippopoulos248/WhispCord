import { EventEmitter } from "node:events";
import type { RunEvent } from "@whispcord/shared";

/** In-process pub/sub for run progress, consumed by the SSE endpoint. */
export class RunEvents {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: RunEvent): void {
    this.emitter.emit(event.runId, event);
  }

  subscribe(runId: string, listener: (e: RunEvent) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}

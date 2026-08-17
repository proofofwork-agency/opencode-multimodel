import type { SideExchange } from "./runner.ts";

export class SideRegistry {
  private readonly exchanges = new Map<string, SideExchange[]>();

  constructor(private readonly limit: number) {}

  record(exchange: SideExchange): void {
    if (this.limit <= 0) return;
    const list = this.exchanges.get(exchange.parentSessionID) ?? [];
    list.push(exchange);
    while (list.length > this.limit) list.shift();
    this.exchanges.set(exchange.parentSessionID, list);
  }

  list(sessionID: string): SideExchange[] {
    return [...(this.exchanges.get(sessionID) ?? [])];
  }

  clear(sessionID?: string): number {
    if (sessionID === undefined) {
      const removed = [...this.exchanges.values()].reduce(
        (total, list) => total + list.length,
        0,
      );
      this.exchanges.clear();
      return removed;
    }
    const removed = this.exchanges.get(sessionID)?.length ?? 0;
    this.exchanges.delete(sessionID);
    return removed;
  }
}

// Pure merge/sort/limit over per-source event rows. The query layer builds
// BusinessEvent[] per source; this is the single ordering rule so the Events
// page and the per-SKU history in Parts can never disagree.

import type { BusinessEvent, EventType } from "./types";

export function assembleEvents(
  sources: BusinessEvent[][],
  opts: { types?: readonly EventType[] | null; limit?: number } = {},
): BusinessEvent[] {
  const { types = null, limit } = opts;
  let events = sources.flat();
  if (types && types.length > 0) {
    const allowed = new Set<EventType>(types);
    events = events.filter((e) => allowed.has(e.type));
  }
  events.sort(compareEvents);
  return limit !== undefined ? events.slice(0, limit) : events;
}

// Newest first by occurrence date; recordedAt breaks ties so same-day events
// keep a stable, arrival-ordered sequence; id as the final total-order tie.
export function compareEvents(a: BusinessEvent, b: BusinessEvent): number {
  if (a.occurredOn !== b.occurredOn) {
    return a.occurredOn < b.occurredOn ? 1 : -1;
  }
  if (a.recordedAt !== b.recordedAt) {
    return a.recordedAt < b.recordedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Group consecutive events by occurrence day for the sticky day headers. */
export function groupByDay(
  events: BusinessEvent[],
): { day: string; events: BusinessEvent[] }[] {
  const groups: { day: string; events: BusinessEvent[] }[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.day === e.occurredOn) {
      last.events.push(e);
    } else {
      groups.push({ day: e.occurredOn, events: [e] });
    }
  }
  return groups;
}

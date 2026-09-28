import type { Broadcast } from './api';

export function overlapsDate(
  broadcast: Pick<Broadcast, 'first_collected_at' | 'last_collected_at'>,
  date: string,
) {
  if (!date) return true;
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return (
    broadcast.first_collected_at < end.getTime() &&
    broadcast.last_collected_at >= start.getTime()
  );
}

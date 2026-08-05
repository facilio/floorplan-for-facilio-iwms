import { useEffect, useState } from 'react';
import { orgNow, subscribeOrgTimezone } from '../lib/orgTime';

/**
 * The ORG's wall clock as reactive state: re-renders when the org timezone resolves (an async
 * fetch — components that read it earlier were stuck on browser time) and once a minute so
 * "past" cut-offs stay honest while a form is open.
 */
export function useOrgClock(): { dateISO: string; minutes: number } {
  const [now, setNow] = useState(() => orgNow());
  useEffect(() => {
    const tick = () => setNow(orgNow());
    const unsub = subscribeOrgTimezone(tick);
    const timer = window.setInterval(tick, 30000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

import type { BudgetReading } from './panel-core.js';

const n = (value: number): string => Math.round(value).toLocaleString('en-US');

export function budgetStatusLine(reading: BudgetReading): string {
  if (reading.status === 'off' || reading.limit === null) {
    return 'No budget is set. Nothing is stopped.';
  }
  const serviceCeiling = reading.limitSource === 'operator'
    ? `This service has a ${n(reading.limit)} token ceiling. ` : '';
  const spent = `I have used ${n(reading.used)} of ${n(reading.limit)} tokens`;
  if (reading.status === 'exhausted') {
    return `${serviceCeiling}${spent}, which is the whole limit. I am stopping Cloud/API calls before they are sent. `
      + 'Local and Agent CLI still run.';
  }
  if (reading.status === 'warning') {
    return `${serviceCeiling}${spent}, which is past the four fifths I flag at. Nothing has slowed down; `
      + 'I stop only when the limit itself is reached.';
  }
  return `${serviceCeiling}${spent}, so ${n(reading.remaining ?? 0)} tokens are left before I stop Cloud/API work.`;
}

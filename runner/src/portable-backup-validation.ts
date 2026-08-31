type Refuse = (message: string) => never;

const COLLECTION_LIMIT = 10_000;
const STRING_LIMIT = 1_000_000;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function validateValue(value: unknown, path: string, refuse: Refuse, depth = 0): void {
  if (depth > 16) refuse(`the backup contains an over-nested ${path}`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse(`the backup contains an invalid number at ${path}`);
    return;
  }
  if (typeof value === 'string') {
    if (Array.from(value).length > STRING_LIMIT || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      refuse(`the backup contains unsafe text at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > COLLECTION_LIMIT) refuse(`the backup contains too many rows at ${path}`);
    value.forEach((item, index) => validateValue(item, `${path}[${index}]`, refuse, depth + 1));
    return;
  }
  const row = record(value);
  if (!row) refuse(`the backup contains an unsupported value at ${path}`);
  const keys = Object.keys(row);
  if (keys.length > 256 || keys.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
    refuse(`the backup contains an unsafe object at ${path}`);
  }
  for (const [key, item] of Object.entries(row)) validateValue(item, `${path}.${key}`, refuse, depth + 1);
}

function validateUrl(value: unknown, path: string, refuse: Refuse): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || value.length > 8_192) refuse(`the backup contains an invalid ${path}`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { refuse(`the backup contains an invalid ${path}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    refuse(`the backup contains an unsafe ${path}`);
  }
}

export function validatePortableDomain(data: Record<string, unknown>, refuse: Refuse): void {
  validateValue(data, 'data', refuse);
  for (const rawPin of data.pins as unknown[]) {
    const pin = record(rawPin);
    const envelope = record(pin?.envelope);
    if (!envelope || typeof envelope.pageTitle !== 'string' || !Array.isArray(envelope.headingPath)) {
      refuse('the backup contains a pin with an invalid capture envelope');
    }
    validateUrl(envelope.url, 'pin URL', refuse);
    validateUrl(envelope.canonicalUrl, 'pin canonical URL', refuse);
  }
  for (const rawCourse of data.courses as unknown[]) {
    const course = record(rawCourse);
    if (!course || !Array.isArray(course.material)) continue;
    for (const rawMaterial of course.material) {
      validateUrl(record(rawMaterial)?.url, 'course material URL', refuse);
    }
  }
  const prefs = record(data.prefs);
  if (!prefs || ![5, 15, 45].includes(Number(prefs.targetMinutes))
      || typeof prefs.interfaceLanguage !== 'string' || !Array.isArray(prefs.excludedDomains)
      || !record(prefs.interview) || !record(prefs.rejectedOrigins)) {
    refuse('the backup contains invalid learner preferences');
  }
}

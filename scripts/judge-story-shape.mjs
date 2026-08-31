/** Pure identity check used before a judge-story application may be a no-op. */
export function sameJudgeStory(current, fixture) {
  const collections = [
    'pins', 'topics', 'edges', 'signals', 'statements', 'sessions', 'suggestions',
    'commitments', 'awards', 'courses', 'intakeDrafts', 'prospects', 'externals', 'outcomes',
  ];
  const rowKey = (key, row) => key === 'edges' ? `${row.from}|${row.to}` : row.id;
  for (const key of collections) {
    const actual = Array.isArray(current[key]) ? current[key] : [];
    const expected = Array.isArray(fixture[key]) ? fixture[key] : [];
    if (actual.length !== expected.length) return false;
    const actualIds = actual.map((row) => rowKey(key, row)).sort();
    const expectedIds = expected.map((row) => rowKey(key, row)).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) return false;
  }
  const currentCourse = current.courses.find((row) => row.id === 'judge-course-ai-systems');
  const fixtureCourse = fixture.courses.find((row) => row.id === 'judge-course-ai-systems');
  const currentSession = current.sessions.find((row) => row.id === 'judge-session-rag');
  const fixtureSession = fixture.sessions.find((row) => row.id === 'judge-session-rag');
  return currentCourse?.sources?.[0]?.digest === fixtureCourse?.sources?.[0]?.digest
    && currentSession?.sections?.[0]?.body === fixtureSession?.sections?.[0]?.body
    && current.prefs?.targetMinutes === fixture.prefs?.targetMinutes
    && current.prefs?.availableMinutes === fixture.prefs?.availableMinutes
    && current.prefs?.interfaceLanguage === fixture.prefs?.interfaceLanguage
    && JSON.stringify(current.aliases ?? {}) === JSON.stringify(fixture.aliases ?? {})
    && JSON.stringify(current.passedOver ?? {}) === JSON.stringify(fixture.passedOver ?? {});
}

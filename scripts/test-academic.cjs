// Run with Node 24: node --test scripts/test-academic.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gradeBand, assessmentGrade, academicTotals, transcriptGroups } = require('../util/academic.ts');
const bands = [
  { min: 80, max: 100, grade: 'A', gradepoint: 4 },
  { min: 70, max: 79, grade: 'B', gradepoint: 3 },
  { min: 60, max: 69, grade: 'C', gradepoint: 2 },
  { min: 50, max: 59, grade: 'D', gradepoint: 1 },
  { min: 0, max: 49, grade: 'F', gradepoint: 0 },
];
const row = (overrides = {}) => ({ sessionId: 's1', session: { title: 'Semester' }, courseId: 'C1',
  scheme: { gradeMeta: bands, passMark: 50 }, credit: 3, status: true, totalScore: 85, ...overrides });

test('decimal thresholds are continuous, without rounding stored scores', () => {
  for (const [score, grade] of [[0,'F'],[49.99,'F'],[50,'D'],[59.5,'D'],[59.999,'D'],[60,'C'],[69.5,'C'],[79.99,'B'],[80,'A'],[100,'A']]) {
    assert.equal(gradeBand(score, bands)?.grade, grade);
  }
  const input = row({ totalScore: 59.5 }); assessmentGrade(input);
  assert.equal(input.totalScore, 59.5);
  assert.equal(gradeBand('59.5', bands).grade, 'D');
});

test('bad scores and broken or genuinely missing grade bands stay invalid', () => {
  for (const score of [-1, 100.1, NaN, Infinity, '', '59bad', false]) assert.equal(gradeBand(score, bands), null);
  assert.equal(gradeBand(65, bands.filter(b => b.grade !== 'C')), null);
  assert.equal(gradeBand(50, null), null);
  assert.equal(assessmentGrade(row({ totalScore: 101 })).exclusionReason, 'Invalid grade or credit');
});

test('zero is a valid published failure and contributes its credits', () => {
  assert.equal(assessmentGrade(row({ totalScore: 0, status: false })).validGrade, true);
  const totals = academicTotals([row(), row({ courseId: 'C2', totalScore: 0 })]);
  assert.equal(totals.cgpa, 2);
  assert.equal(totals.credit, 6);
  assert.equal(totals.failedCourses, 1);
});

test('incomplete, invalid and unpublished results do not dilute GPA', () => {
  const totals = academicTotals([row(), row({ totalScore: null }), row({ totalScore: 101 }), row({ status: false, totalScore: 10 })]);
  assert.deepEqual(totals, { credit: 3, gradepoint: 12, gpa: 4, cgpa: 4, incomplete: 1, invalid: 1, unpublished: 1, failedCourses: 0 });
  assert.equal(academicTotals([row({ totalScore: null })]).cgpa, null);
  assert.equal(academicTotals([]).cgpa, null);
});

test('CGPA weights credits rather than averaging semester GPAs', () => {
  const groups = transcriptGroups([row(), row({ sessionId: 's2', totalScore: 50, credit: 6 })]);
  assert.equal(groups[0][2].gpa, 4);
  assert.equal(groups[1][2].gpa, 1);
  assert.equal(groups[1][2].cgpa, 2);
  assert.equal(groups[1][2].cumulativeCredit, 9);
  assert.equal(groups[1][2].cumulativeGradepoint, 18);
});

test('distinct sessions sharing a display title remain separate', () => {
  const groups = transcriptGroups([row(), row({ sessionId: 's2' })]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1][2].cumulativeCredit, 6);
});

test('resit passes resolve course warnings without rewriting attempt history', () => {
  const rows = [row({ totalScore: 20 }), row({ totalScore: 60, sessionId: 's2', type: 'R' })];
  assert.equal(academicTotals(rows).failedCourses, 0);
  assert.equal(academicTotals(rows).cgpa, 1);
  assert.equal(academicTotals([rows[0], { ...rows[1], status: false }]).failedCourses, 1);
});

test('dashboard, results, print totals and graduation consume the same metadata', async () => {
  const { transcriptSummary, formatGpa, visiblePoints, visibleGrade } = await import('../../frontend/src/utils/academic.ts');
  const rows = [row(), row({ totalScore: null }), row({ totalScore: 0, courseId: 'C2', sessionId: 's2' }), row({ status: false })];
  const groups = transcriptGroups(rows);
  const summary = transcriptSummary(groups);
  assert.equal(summary.available, true);
  assert.equal(summary.cgpa, academicTotals(rows).cgpa);
  assert.equal(summary.cgpas.at(-1), formatGpa(summary.cgpa));
  assert.equal(summary.credit, summary.credits.at(-1));
  assert.equal(summary.points.at(-1), academicTotals(rows).gradepoint);
  assert.equal(visiblePoints(groups[1][1][0]), '0.0');
  assert.equal(visibleGrade(groups[0][1][2]), 'Unpublished');
  assert.equal(visiblePoints(groups[0][1][2]), '--');
  assert.equal(formatGpa(null), '--');
});

test('dashboard failures are unavailable, never a clear or zero CGPA', async () => {
  const { transcriptSummary, resitNotice, studentStatus } = await import('../../frontend/src/utils/academic.ts');
  for (const missing of [undefined, null, { message: 'Error' }]) {
    assert.equal(transcriptSummary(missing).available, false);
    assert.equal(resitNotice(missing).badge, 'UNAVAILABLE');
    assert.equal(studentStatus(missing), 'Unavailable');
  }
  assert.equal(resitNotice({ resit: { count: 0, items: [] } }).badge, 'NONE RECORDED');
  assert.equal(studentStatus({ completeStatus: false, deferStatus: true }), 'Deferred');
  assert.equal(studentStatus({ completeStatus: true, deferStatus: false }), 'Completed');
  assert.equal(studentStatus({ completeStatus: false, deferStatus: false }), 'Active');
  assert.equal(transcriptSummary([['old response', [], { cgpa: 4 }]]).available, false);
});

// Exercise the actual view loaders and rendered publication controls without
// touching student records or requiring a logged-in browser session.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRequire } = require('node:module');
const frontend = path.resolve(__dirname, '../../frontend');
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const React = frontendRequire('react');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');
function loadView(relative, mocks) {
  const filename = path.join(frontend, relative);
  const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { module: mod, exports: mod.exports, console, require: name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'react') return React;
    return frontendRequire(name);
  } }, { filename });
  return mod.exports;
}

test('both real print loaders return the server totals, including exclusions', async () => {
  const presentation = await import('../../frontend/src/utils/academic.ts');
  const groups = transcriptGroups([row(), row({ totalScore: 0 }), row({ totalScore: null }), row({ status: false })]);
  const mocks = {
    '../../utils/academic': presentation,
    '../../utils/aisService': { fetchStudentTranscript: async () => groups, fetchTranswift: async () => ({ studentId: 'fixture' }) },
    '../../utils/authService': { useUserStore: { getState: () => ({ user: { user: { tag: 'fixture' } } }) } },
    'react-router-dom': {}, 'react-to-print': {}, './FormPrint.css': {},
    './PrintHeader': () => null, './TranscriptNoHeader': () => null,
  };
  for (const name of ['PrintTranscript', 'PaperTranscriptView']) {
    const view = loadView(`src/components/print/${name}.tsx`, mocks);
    const result = await view.loader({ params: { studentId: 'fixture', transwiftId: 'fixture' } });
    assert.equal(result.currentCgpa, 2);
    assert.equal(result.cgpa.at(-1), '2.00');
    assert.equal(result.crt.at(-1), 6);
    assert.equal(result.gpt.at(-1), 12);
  }
});

test('admin statement enables publishing zero, disables incomplete and marks published', async () => {
  const presentation = await import('../../frontend/src/utils/academic.ts');
  const groups = transcriptGroups([row({ id: 'zero', status: false, totalScore: 0 }), row({ id: 'incomplete', status: false, totalScore: null }), row({ id: 'published' })]);
  const view = loadView('src/components/ais/AISResultCard.tsx', {
    '../../utils/academic': presentation, '../../utils/aisService': {},
    '../../utils/roles': { useHasRole: () => true }, 'react-router': { useNavigate: () => () => {} },
  });
  const html = renderToStaticMarkup(React.createElement(view.default, { title: 'Fixture', data: groups[0][1], meta: groups[0][2] }));
  const publishButtons = html.match(/<button[^>]*>Publish<\/button>/g);
  assert.equal(publishButtons.length, 2);
  assert.doesNotMatch(publishButtons[0], /disabled=""/);
  assert.match(publishButtons[1], /disabled=""/);
  assert.match(html, />Published<\/span>/);
  assert.match(html, /Excluded: Unpublished/);
  assert.match(html, /Excluded: Incomplete/);
});

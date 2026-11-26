import { test } from 'node:test';
import assert from 'node:assert/strict';
import tool, { extractFirstError, processError } from '../tools/get-autotests-report.mjs';

process.env.MCP_JENKINS_URL = 'http://jenkins.test';
process.env.MCP_JENKINS_USER = 'u';
process.env.MCP_JENKINS_API_TOKEN = 't';

const FOLDER = '/job/223/job/223-3%20Stable%20Tests';

// Мок Jenkins: routes = { '<path>': { status?, json?, text? } }
function mockJenkins(routes, seen = []) {
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    seen.push(url);
    const r = routes[path];
    if (!r) return new Response('nf', { status: 404, statusText: 'Not Found' });
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : r.text, { status: r.status ?? 200 });
  };
  return seen;
}

test('extractFirstError: паттерны и исключения', () => {
  const log = ['ok', 'ERROR: Failed to launch x', 'Cannot contact node: Exception', 'java.lang.NullPointerException: a', 'ERROR later'].join('\n');
  assert.equal(extractFirstError(log), 'java.lang.NullPointerException: a');
  assert.equal(extractFirstError('all fine'), null);
  assert.equal(extractFirstError(''), null);
});

test('processError: подмена, null, passthrough', () => {
  assert.equal(processError(null), 'Ошибка не найдена');
  assert.equal(processError('foo Could not connect bar'), 'Сбой работы контейнера (Could not connect...)');
  assert.equal(processError('AssertionError: [ОШИБКА]: загруженный файл [a.zip]'), 'Не удалось загрузить файл, архив или файл отсутствует в архиве');
  assert.equal(processError('Some Exception'), 'Some Exception');
});

test('отчёт: статистика, группировка, заголовок 223, неполные данные', async () => {
  const jobs = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ name: n, displayName: `Test ${n}` }));
  const build = (n, result) => ({ json: { number: n, result } });
  mockJenkins({
    [`${FOLDER}/api/json`]: { json: { jobs } },
    [`${FOLDER}/job/a/lastBuild/api/json`]: build(10, 'SUCCESS'),
    [`${FOLDER}/job/b/lastBuild/api/json`]: build(20, 'FAILURE'),
    [`${FOLDER}/job/b/20/consoleText`]: { text: 'x\njava.lang.RuntimeException: boom\n' },
    [`${FOLDER}/job/c/lastBuild/api/json`]: build(30, 'FAILURE'),
    [`${FOLDER}/job/c/30/consoleText`]: { text: 'java.lang.RuntimeException: boom' },
    [`${FOLDER}/job/d/lastBuild/api/json`]: build(40, null), // идёт сейчас -> UNKNOWN
    [`${FOLDER}/job/d/40/consoleText`]: { text: 'Could not connect to x' },
    [`${FOLDER}/job/e/lastBuild/api/json`]: build(50, 'ABORTED'),
    [`${FOLDER}/job/e/50/consoleText`]: { text: 'nothing here' },
    // job f: lastBuild -> 404 -> ERROR
  });
  const text = await tool.handler({ stand: 'Stable' });

  assert.match(text, /Всего тестов: 6\nУспешных: 1 \(16%\)\nУпавших: 2 \(33%\)\nДругих статусов: 3 \(50%\)/);
  assert.match(text, /Всего групп ошибок: 3/);
  assert.match(text, /Разбор и анализ автотестов на Stable \[\d\d\.\d\d\.\d{4}\] \nиз 6 тестов \n5 упало \n1 прошло успешно /);
  // группа из 2: имена без ссылок + ссылка на последний
  assert.match(text, /Test b#20\nTest c#30\nhttp:\/\/jenkins\.test\/job\/223\/job\/223-3%20Stable%20Tests\/job\/c\/30\/\n❌\nОшибка: java\.lang\.RuntimeException: boom\nКоличество тестов: 2\n/);
  // одиночная группа: имя + ссылка
  assert.match(text, /Test d#40\nhttp:\/\/jenkins\.test\/[^\n]+\/job\/d\/40\/\n❌\nОшибка: Сбой работы контейнера \(Could not connect\.\.\.\)\nКоличество тестов: 1/);
  // ABORTED без ошибки в логе и ERROR-джоба -> «Ошибка не найдена»
  assert.match(text, /Ошибка: Ошибка не найдена\nКоличество тестов: 2/);
  // неполные данные обозначены явно
  assert.match(text, /ВНИМАНИЕ: данные неполные, не удалось обработать джоб: 1/);
  assert.match(text, /Test f \(f\): Jenkins вернул 404/);
});

test('ошибки: неизвестный стенд, пустая папка, недоступность списка джоб', async () => {
  await assert.rejects(tool.handler({ stand: 'Nope' }), /Неизвестное значение: Nope/);
  mockJenkins({ [`${FOLDER}/api/json`]: { json: { jobs: [] } } });
  await assert.rejects(tool.handler({}), /нет джоб/);
  mockJenkins({});
  await assert.rejects(tool.handler({ stand: 'Stable' }), /Jenkins вернул 404/);
});

test('все успешные: нет логов и групп, консоль не запрашивается', async () => {
  const seen = mockJenkins({
    [`${FOLDER}/api/json`]: { json: { jobs: [{ name: 'a', displayName: 'A' }] } },
    [`${FOLDER}/job/a/lastBuild/api/json`]: { json: { number: 1, result: 'SUCCESS' } },
  });
  const text = await tool.handler({});
  assert.match(text, /Успешных: 1 \(100%\)/);
  assert.match(text, /Всего групп ошибок: 0/);
  assert.ok(!seen.some((u) => u.includes('consoleText')));
});

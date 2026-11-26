// Tool: jenkins_get_autotests_report
// Перенос Java-отчёта JenkinsErrorAggregator: по последнему билду каждой джобы стенда
// собирает статистику и группирует упавшие тесты по первой найденной в логе ошибке.

import { cpus } from 'node:os';
import { jenkinsGet, jenkinsGetText, jenkinsUrl, folderToPath } from '../jenkins-client.mjs';

// Стенд -> папка Jenkins (как в selectStand() Java-реализации)
const STAND_FOLDERS = {
  Servicing: '223/223-2 Servicing Tests',
  Stable: '223/223-3 Stable Tests',
  Trunk: '223/223-1 Trunk Tests',
  Integration: '223/223-6 Integration Tests',
};

const NO_ERROR_TEXT = 'Ошибка не найдена';

// LogErrorExtractor
const ERROR_PATTERNS = [
  'Exception',
  'Element should',
  '[ОШИБКА]:',
  'Не удалось создать сессию драйвера',
  'Could not connect',
  '(checkContractStatus) Некорректный статус договора:',
  'ERROR',
];

const EXCLUSION_PATTERNS = [
  'ERROR: Failed to launch',
  'KubernetesClientTimeoutException',
  'ERROR Log4j2',
  '[ОШИБКА]: искомое значение задублировано в колонке [Тема]',
  '[ОШИБКА]: результаты поиска содержат более одного уведомления',
  '[ОШИБКА]: запись о действии [Публикация процедуры] в диалоговом окне [История]',
  '[ОШИБКА]: записи в диалоговом окне [История] отсутствуют',
  '[ОШИБКА]: заголовок содержит не корректное значение',
  '[ОШИБКА]: SHA1 Hash не найден в ответе',
  'Cannot contact',
];

// ConfigurableErrorProcessor (порядок важен: берётся первое совпадение)
const ERROR_MESSAGES = [
  ['ERROR: Failed to launch', 'Не удалось запустить агента'],
  ['Could not connect', 'Сбой работы контейнера (Could not connect...)'],
  [
    'AssertionError: [ОШИБКА]: загруженный файл [',
    'Не удалось загрузить файл, архив или файл отсутствует в архиве',
  ],
];

/** Первая строка лога, содержащая паттерн ошибки и не содержащая исключений; иначе null. */
export function extractFirstError(logs) {
  const line = logs
    .split('\n')
    .find((l) => ERROR_PATTERNS.some((p) => l.includes(p)) && !EXCLUSION_PATTERNS.some((p) => l.includes(p)));
  return line ?? null;
}

/** Заменяет известные ошибки понятным текстом; null -> «Ошибка не найдена». */
export function processError(error) {
  if (error == null) return NO_ERROR_TEXT;
  const known = ERROR_MESSAGES.find(([pattern]) => error.includes(pattern));
  return known ? known[1] : error;
}

// JobProcessor.call(): статус последнего билда + ошибка из лога для всех, кроме SUCCESS.
// Любая ошибка обработки одной джобы не валит отчёт: джоба получает статус ERROR.
async function processJob({ name, displayName }, folderPath) {
  const jobPath = `${folderPath}/job/${encodeURIComponent(name)}`;
  try {
    const lastBuild = await jenkinsGet(`${jobPath}/lastBuild/api/json`, { tree: 'number,result' });
    if (lastBuild == null) return { name, displayName, status: 'UNKNOWN', buildNumber: 0, error: null };

    // asInt()/asText("UNKNOWN") в Java: отсутствующее/null значение -> 0 / "UNKNOWN"
    // (result == null у билда, который ещё выполняется)
    const buildNumber = lastBuild.number ?? 0;
    const status = lastBuild.result ?? 'UNKNOWN';

    let error = null;
    if (status !== 'SUCCESS') {
      const logs = await jenkinsGetText(`${jobPath}/${buildNumber}/consoleText`);
      error = processError(extractFirstError(logs));
    }
    return { name, displayName, status, buildNumber, error };
  } catch (e) {
    return { name, displayName, status: 'ERROR', buildNumber: 0, error: null, problem: e.message };
  }
}

// Пул фиксированного размера (аналог newFixedThreadPool); fn не должна бросать исключения.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

const pct = (part, total) => Math.floor((part * 100) / total); // целочисленное деление, как в Java
const pad = (n) => String(n).padStart(2, '0');
const formatDate = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;

// printResults(): та же структура и тексты, что в консольном выводе Java
function renderReport({ stand, results, folderPath }) {
  const total = results.length;
  let success = 0;
  let failed = 0;
  let other = 0;
  const groups = new Map(); // текст ошибки -> [{ title, url }]
  const addToGroup = (r) => {
    const key = r.error ?? NO_ERROR_TEXT;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      title: `${r.displayName}#${r.buildNumber}`,
      url: jenkinsUrl(`${folderPath}/job/${encodeURIComponent(r.name)}/${r.buildNumber}/`),
    });
  };

  for (const r of results) {
    if (r.status === 'SUCCESS') {
      success++;
    } else if (r.status === 'FAILURE') {
      failed++;
      if (r.error != null) addToGroup(r);
    } else {
      other++;
      addToGroup(r); // в Java здесь null-ключ приводил к NPE; такие джобы идут в «Ошибка не найдена»
    }
  }

  const lines = [
    '=== Общая статистика ===',
    '',
    `Всего тестов: ${total}`,
    `Успешных: ${success} (${pct(success, total)}%)`,
    `Упавших: ${failed} (${pct(failed, total)}%)`,
    `Других статусов: ${other} (${pct(other, total)}%)`,
    '',
    '=== Группировка упавших тестов по ошибкам ===',
    `Всего групп ошибок: ${groups.size}`,
    '',
    '=== Отчет по шаблону 223 ===',
    `Разбор и анализ автотестов на ${stand} [${formatDate(new Date())}] `,
    `из ${total} тестов `,
    `${failed + other} упало `,
    `${success} прошло успешно `,
    '-------------------------------------------------------------------',
  ];

  for (const [error, jobs] of groups) {
    if (jobs.length !== 1) {
      // группа из нескольких тестов: имена без ссылок + ссылка на последний тест
      lines.push(...jobs.map((j) => j.title), jobs.at(-1).url);
    } else {
      lines.push(jobs[0].title, jobs[0].url);
    }
    lines.push('❌', `Ошибка: ${error}`, `Количество тестов: ${jobs.length}`, '');
  }

  // Джобы, которые не удалось обработать, не должны маскироваться под «обычные» статусы
  const problems = results.filter((r) => r.problem);
  if (problems.length) {
    lines.push(
      `=== ВНИМАНИЕ: данные неполные, не удалось обработать джоб: ${problems.length} (учтены как «Других статусов») ===`,
      ...problems.map((r) => `${r.displayName} (${r.name}): ${r.problem}`),
      '',
    );
  }
  return lines.join('\n');
}

export default {
  name: 'jenkins_get_autotests_report',
  description:
    'Формирует отчёт по результатам прогона автотестов 223 на выбранном стенде Jenkins: ' +
    'статистика (всего/успешных/упавших/других статусов) и группировка упавших тестов по первой ошибке из лога ' +
    'последнего билда каждой джобы, в формате шаблона «Разбор и анализ автотестов». ' +
    'Вызывай, когда нужен разбор прогона автотестов целиком. Для простого списка упавших джоб используй jenkins_get_failed_jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      stand: {
        type: 'string',
        enum: Object.keys(STAND_FOLDERS),
        default: 'Stable',
        description: 'Стенд, по которому строится отчёт. По умолчанию Stable',
      },
    },
  },

  async handler({ stand = 'Stable' } = {}) {
    const folder = STAND_FOLDERS[stand];
    if (!folder) throw new Error(`Неизвестное значение: ${stand}`);
    const folderPath = folderToPath(folder);

    // 1. Все джобы стенда с displayName
    const { jobs = [] } = await jenkinsGet(`${folderPath}/api/json`, { tree: 'jobs[name,displayName]' });
    if (jobs.length === 0) throw new Error(`В папке "${folder}" нет джоб`);

    // 2. Параллельная обработка (размер пула как в Java: число ядер * 2, но не больше числа джоб)
    const poolSize = Math.min(jobs.length, (cpus().length || 1) * 2);
    const results = await mapPool(jobs, poolSize, (job) => processJob(job, folderPath));

    // 3. Итоговый отчёт
    return renderReport({ stand, results, folderPath });
  },
};

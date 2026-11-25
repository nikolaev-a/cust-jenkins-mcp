// Tool: jenkins_get_failed_jobs
// Берёт все джобы папки ОДНИМ запросом и возвращает только упавшие.

import { jenkinsGet, folderToPath, defaultFolder } from '../jenkins-client.mjs';

const TREE = 'jobs[name,color,lastCompletedBuild[number,result,timestamp,url]]';

export default {
  name: 'jenkins_get_failed_jobs',
  description:
    'Возвращает только упавшие джобы папки Jenkins (по последнему завершённому билду). ' +
    'Поле running=true значит, что прямо сейчас идёт перезапуск этой джобы.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: 'Путь к папке через "/", напр. "223/223-3 Stable Tests". По умолчанию из JENKINS_DEFAULT_FOLDER',
      },
      includeUnstable: { type: 'boolean', default: true, description: 'Считать UNSTABLE (жёлтые) упавшими' },
      onlyNotRunning: { type: 'boolean', default: false, description: 'Скрыть джобы, которые прямо сейчас перезапускаются' },
    },
  },

  async handler({ folder, includeUnstable = true, onlyNotRunning = false }) {
    const target = folder ?? defaultFolder();
    const { jobs = [] } = await jenkinsGet(`${folderToPath(target)}/api/json`, { tree: TREE });
    const bad = new Set(includeUnstable ? ['FAILURE', 'UNSTABLE'] : ['FAILURE']);

    let failed = jobs
      .filter((j) => bad.has(j.lastCompletedBuild?.result))
      .map((j) => ({
        name: j.name,
        result: j.lastCompletedBuild.result,
        build: j.lastCompletedBuild.number,
        running: String(j.color).endsWith('_anime'),
        finishedAt: new Date(j.lastCompletedBuild.timestamp).toISOString(),
        url: j.lastCompletedBuild.url,
      }));
    if (onlyNotRunning) failed = failed.filter((j) => !j.running);

    return { folder: target || '(корень)', totalJobs: jobs.length, failedCount: failed.length, failed };
  },
};

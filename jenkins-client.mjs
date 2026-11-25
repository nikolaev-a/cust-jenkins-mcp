// Общий доступ к Jenkins для всех tools. Настройки берутся из переменных окружения
// (их задаёт mcp.json / run-jenkins-custom-mcp.js), читаются при первом обращении,
// поэтому tools, которым Jenkins не нужен, не требуют этих переменных.
//
//   MCP_JENKINS_URL          http://jenkins-223.devtest.local
//   MCP_JENKINS_USER         логин      (или JENKINS_USER)
//   MCP_JENKINS_API_TOKEN    API-токен  (или JENKINS_API_TOKEN)
//   MCP_JENKINS_TIMEOUT_MS   (необязательно) таймаут, по умолчанию 30000
//   JENKINS_DEFAULT_FOLDER   (необязательно) папка по умолчанию, напр. "223/223-3 Stable Tests"

function config() {
  const baseUrl = (process.env.MCP_JENKINS_URL || '').replace(/\/+$/, '');
  const user = process.env.MCP_JENKINS_USER || process.env.JENKINS_USER;
  const token = process.env.MCP_JENKINS_API_TOKEN || process.env.JENKINS_API_TOKEN;
  if (!baseUrl || !user || !token) {
    throw new Error('Не заданы MCP_JENKINS_URL, MCP_JENKINS_USER (JENKINS_USER), MCP_JENKINS_API_TOKEN (JENKINS_API_TOKEN)');
  }
  return {
    baseUrl,
    auth: 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64'),
    timeoutMs: Number(process.env.MCP_JENKINS_TIMEOUT_MS) || 30000,
  };
}

export const defaultFolder = () => process.env.JENKINS_DEFAULT_FOLDER || '';

// "223/223-3 Stable Tests" -> "/job/223/job/223-3%20Stable%20Tests"
export const folderToPath = (folder) =>
  folder
    .split('/')
    .filter(Boolean)
    .map((part) => `/job/${encodeURIComponent(part)}`)
    .join('');

// GET к Jenkins, возвращает распарсенный JSON.
// jenkinsGet('/job/223/api/json', { tree: 'jobs[name]' })
export async function jenkinsGet(path, params = {}) {
  const { baseUrl, auth, timeoutMs } = config();
  const query = new URLSearchParams(params).toString();
  const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Jenkins вернул ${res.status} ${res.statusText} для ${url}`);
  return res.json();
}

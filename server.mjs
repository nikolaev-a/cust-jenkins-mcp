// MCP-сервер: ядро. Знает только протокол и умеет подхватывать tools из папки ./tools
// Каждый файл tools/*.mjs = один метод (export default { name, description, inputSchema, handler }).
// Без зависимостей: не нужны ни npm install, ни node_modules. Нужна Node 18+.
// Новый tool добавили -> перезапустили сервер.

import { createInterface } from 'node:readline';
import { readdir } from 'node:fs/promises';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOLS_DIR = new URL('./tools/', import.meta.url);

// ---------- загрузка tools ----------

async function loadTools() {
  const tools = new Map();
  const files = (await readdir(TOOLS_DIR)).filter((f) => f.endsWith('.mjs')).sort();
  for (const file of files) {
    try {
      const tool = (await import(new URL(file, TOOLS_DIR).href)).default;
      if (!tool?.name || typeof tool.handler !== 'function') {
        throw new Error('ожидается export default { name, description, inputSchema, handler }');
      }
      if (tools.has(tool.name)) throw new Error(`имя "${tool.name}" уже занято другим файлом`);
      tools.set(tool.name, tool);
    } catch (e) {
      // сломанный файл не должен ронять остальные tools; stdout занят протоколом, пишем в stderr
      console.error(`[mcp] tools/${file} пропущен: ${e.message}`);
    }
  }
  console.error(`[mcp] загружены tools: ${[...tools.keys()].join(', ') || '(нет)'}`);
  return tools;
}

const tools = await loadTools();

// ---------- протокол MCP поверх stdio: одна JSON-строка = одно сообщение ----------

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(wanted) ? wanted : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'jenkins-custom', version: '1.0.0' },
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        })),
      });
    case 'tools/call': {
      const tool = tools.get(params?.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.handler(params.arguments ?? {});
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { isError: true, content: [{ type: 'text', text: `Ошибка: ${e.message}` }] });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  if (msg.id === undefined) return; // notifications ответа не требуют
  handle(msg);
});

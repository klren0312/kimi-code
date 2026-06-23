import {
  Agent,
  buildConnector,
  type Dispatcher,
  EnvHttpProxyAgent,
  setGlobalDispatcher as undiciSetGlobalDispatcher,
} from 'undici';
import { SocksClient } from 'socks';

type Env = Readonly<Record<string, string | undefined>>;

/** 解析后的 SOCKS 代理端点，符合 `socks` 客户端的预期格式。 */
export interface SocksProxyConfig {
  /** SOCKS 协议版本：4（socks4/socks4a）或 5（socks/socks5/socks5h）。 */
  readonly type: 4 | 5;
  readonly host: string;
  readonly port: number;
  readonly userId?: string;
  readonly password?: string;
}

// 回环主机始终绕过代理。undici 的 EnvHttpProxyAgent、Node 的 `--use-env-proxy`
// 和我们的 SOCKS 连接器默认都不会豁免回环地址，因此如果用户设置了代理，
// `http://localhost:PORT` 的流量（如本地 MCP 服务器）会被路由通过代理
// ——这是一个只有代理用户会遇到的令人困惑的故障。
// `::1` 和带方括号的 `[::1]` 都列出：undici 的 EnvHttpProxyAgent 仅在
// NO_PROXY 条目带方括号时才绕过 IPv6 回环（否则会将 `::1` 错误解析为
// 主机 `:` 端口 `1`），而我们的 SOCKS 匹配器会去掉方括号——因此同时包含
// 两者以覆盖所有路径。
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);

/** 小写 URL scheme（不含尾部冒号），不存在时为 undefined。 */
function schemeOf(value: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
}

/** `keys` 中第一个非空值（调用方传入两种大小写形式）。 */
function firstNonBlank(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** 如果值是 HTTP/HTTPS scheme 代理（非 SOCKS）则返回该值，否则返回 undefined。 */
function httpSchemeValue(value: string | undefined): string | undefined {
  return value !== undefined && !SOCKS_SCHEMES.has(schemeOf(value) ?? '') ? value : undefined;
}

/**
 * 当通过 `HTTP_PROXY`、`HTTPS_PROXY` 或 http scheme 的 `ALL_PROXY`（兜底回退）
 * 配置了 HTTP/HTTPS 代理时返回 true。
 */
function hasHttpProxy(env: Env): boolean {
  return [
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
  ].some((value) => httpSchemeValue(value) !== undefined);
}

/**
 * 解析有效的 http/https 代理 URL：优先使用 scheme 特定的
 * `HTTP_PROXY`/`HTTPS_PROXY`（忽略 SOCKS scheme 的值），回退到
 * http scheme 的 `ALL_PROXY` 兜底。没有可用值的 scheme 返回 `undefined`。
 */
function resolveHttpProxyUrls(env: Env): { httpProxy?: string; httpsProxy?: string } {
  const allProxy = httpSchemeValue(firstNonBlank(env, ['all_proxy', 'ALL_PROXY']));
  return {
    httpProxy: httpSchemeValue(firstNonBlank(env, ['http_proxy', 'HTTP_PROXY'])) ?? allProxy,
    httpsProxy: httpSchemeValue(firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY'])) ?? allProxy,
  };
}

/**
 * 从环境变量解析 SOCKS 代理，没有则返回 `undefined`。SOCKS 代理可通过
 * `ALL_PROXY`（Clash / V2RayN 常见形式）或在 `HTTP(S)_PROXY` 中使用
 * `socks*` scheme 声明。优先级：`ALL_PROXY` > `HTTPS_PROXY` > `HTTP_PROXY`。
 * `socks://` 是 `socks5://` 的别名。
 */
export function resolveSocksProxy(env: Env = process.env): SocksProxyConfig | undefined {
  const candidates = [
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
  ];
  for (const value of candidates) {
    if (value === undefined) continue;
    const scheme = schemeOf(value);
    if (scheme === undefined || !SOCKS_SCHEMES.has(scheme)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const config: SocksProxyConfig = {
      type: scheme === 'socks4' || scheme === 'socks4a' ? 4 : 5,
      // 去除 IPv6 方括号：`socks` 客户端需要裸地址（`::1`），
      // 而非 URL 的带方括号形式 `[::1]`（会被当作主机名处理）。
      host: url.hostname.replaceAll(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 1080,
      ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
    return config;
  }
  return undefined;
}

/** 当任何 HTTP(S) 或 SOCKS 代理变量被设置为可用值时返回 true。 */
export function isProxyConfigured(env: Env = process.env): boolean {
  return hasHttpProxy(env) || resolveSocksProxy(env) !== undefined;
}

/**
 * 有效的 `NO_PROXY`，保证包含回环主机以使本地流量直连。读取两种大小写
 * （非空时优先小写，与 undici 一致），保留用户的条目，仅追加缺失的回环主机。
 *
 * `*` 通配符（"绕过所有"）原样返回：undici 仅将其作为精确字符串匹配处理，
 * 追加回环地址会静默破坏用户的显式选择，将所有非回环流量路由通过代理。
 */
export function resolveNoProxy(env: Env = process.env): string {
  // 优先使用第一个非空大小写形式；空的 `no_proxy=''` 不应遮蔽有值的
  // `NO_PROXY`（`??` 会，因为 `''` 不是 nullish）。
  const raw = [env['no_proxy'], env['NO_PROXY']].find((value) => (value?.trim() ?? '').length > 0) ?? '';
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.includes('*')) return '*';
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!hosts.includes(loopback)) hosts.push(loopback);
  }
  return hosts.join(',');
}

/**
 * 构建一个谓词函数，给定 `NO_PROXY` 字符串，判断主机（和可选端口）是否
 * 应绕过代理。匹配 `*`（全部）、精确主机，以及裸域名（`example.com`）和
 * 前导点（`.example.com`）条目的子域名；带端口的条目（`host:443`）仅匹配
 * 该端口。用于 SOCKS 路径，因为 undici 不为我们处理绕过。
 */
export function makeNoProxyMatcher(noProxy: string): (host: string, port?: number | string) => boolean {
  const entries = noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.includes('*')) return () => true;
  const parsed = entries.map(parseNoProxyEntry);
  return (host: string, port?: number | string) => {
    const target = host.toLowerCase().replaceAll(/^\[|\]$/g, '');
    const targetPort = port === undefined ? undefined : String(port);
    return parsed.some(
      ({ host: entry, port: entryPort }) =>
        (entryPort === undefined || entryPort === targetPort) &&
        (target === entry || target.endsWith(`.${entry}`)),
    );
  };
}

/**
 * 将 `NO_PROXY` 条目拆分为主机（去掉前导 `.`）和可选端口。
 * 处理带方括号的 IPv6（`[::1]:443`），避免将裸 IPv6 地址的冒号
 *（`::1`）误认为 `host:port` 分隔符。
 */
function parseNoProxyEntry(entry: string): { host: string; port?: string } {
  let host = entry;
  let port: string | undefined;
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    host = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    if (rest.startsWith(':')) port = rest.slice(1);
  } else {
    const colon = entry.indexOf(':');
    // 只有单个冒号后跟数字才是端口；多个冒号意味着裸 IPv6 地址
    //（如 `::1`），不含端口。
    if (colon !== -1 && colon === entry.lastIndexOf(':') && /^\d+$/.test(entry.slice(colon + 1))) {
      host = entry.slice(0, colon);
      port = entry.slice(colon + 1);
    }
  }
  // 将通配域名（`*.example.com`）和前导点（`.example.com`）标准化为裸域名；
  // 子域名匹配在下方处理。
  if (host.startsWith('*.')) host = host.slice(2);
  else if (host.startsWith('.')) host = host.slice(1);
  return port === undefined ? { host } : { host, port };
}

export interface ProxyAgentFactories {
  /** 构建 HTTP/HTTPS 代理的 dispatcher。 */
  readonly makeHttpAgent: (options: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy: string;
  }) => Dispatcher;
  /** 构建 SOCKS 代理的 dispatcher。 */
  readonly makeSocksAgent: (options: { proxy: SocksProxyConfig; noProxy: string }) => Dispatcher;
}

const defaultMakeHttpAgent: ProxyAgentFactories['makeHttpAgent'] = ({ httpProxy, httpsProxy, noProxy }) =>
  // 显式传入已解析的代理 URL：如果交给 EnvHttpProxyAgent 自行读取
  // `http_proxy ?? HTTP_PROXY`，空的小写值会遮蔽有值的大写形式，
  // 静默禁用代理。noProxy 同样预先解析以保证回环绕过。
  new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });

const defaultMakeSocksAgent: ProxyAgentFactories['makeSocksAgent'] = ({ proxy, noProxy }) => {
  // undici 不支持 SOCKS，因此我们驱动一个自定义连接器：通过 SOCKS 代理
  // 使用 `socks` 客户端隧道传输目标，然后将已建立的 socket 交还给
  // undici 的连接器——它会为 https 目标执行 TLS 升级（复用 undici 的
  // ALPN/服务器名称处理）。
  const directConnect = buildConnector({});
  const bypass = makeNoProxyMatcher(noProxy);
  const connect: typeof directConnect = (options, callback) => {
    if (bypass(options.hostname, options.port)) {
      directConnect(options, callback);
      return;
    }
    void (async () => {
      try {
        const isTls = options.protocol === 'https:';
        const port = Number(options.port) || (isTls ? 443 : 80);
        const { socket } = await SocksClient.createConnection({
          proxy: { host: proxy.host, port: proxy.port, type: proxy.type, userId: proxy.userId, password: proxy.password },
          command: 'connect',
          destination: { host: options.hostname, port },
        });
        if (isTls) {
          // 通过 undici 自己的连接器将 SOCKS socket 升级为 TLS。
          directConnect({ ...options, httpSocket: socket } as Parameters<typeof directConnect>[0], callback);
        } else {
          socket.setNoDelay(true);
          callback(null, socket);
        }
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), null);
      }
    })();
  };
  return new Agent({ connect });
};

/**
 * 构建一个 undici dispatcher，将出站 `fetch` 路由通过已配置的代理，
 * 同时遵守（增强回环的）`NO_PROXY`。HTTP/HTTPS 代理优先匹配流量；
 * 否则使用 SOCKS 代理（`ALL_PROXY` 或 `socks*` scheme）。未设置代理变量时
 * 返回 `undefined`，使无配置的大多数用户保持 Node 默认 dispatcher 不变。
 */
export function createProxyDispatcher(
  env: Env = process.env,
  factories: Partial<ProxyAgentFactories> = {},
): Dispatcher | undefined {
  const { makeHttpAgent = defaultMakeHttpAgent, makeSocksAgent = defaultMakeSocksAgent } = factories;
  try {
    if (hasHttpProxy(env)) {
      // 将缺失值强制为 ''（对 undici 为 falsy），使 EnvHttpProxyAgent 既不会
      // 从 socks: URI 构建损坏的 agent，也不会从环境变量重新读取被遮蔽的空值。
      const { httpProxy, httpsProxy } = resolveHttpProxyUrls(env);
      return makeHttpAgent({
        httpProxy: httpProxy ?? '',
        httpsProxy: httpsProxy ?? '',
        noProxy: resolveNoProxy(env),
      });
    }
    const socks = resolveSocksProxy(env);
    if (socks !== undefined) {
      return makeSocksAgent({ proxy: socks, noProxy: resolveNoProxy(env) });
    }
    return undefined;
  } catch (error) {
    // 格式错误的代理 URL 会导致 agent 构造同步抛出。不要用原始栈跟踪
    // 中止启动——报告错误并回退到直连。
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`kimi: ignoring invalid proxy configuration (${reason}); connecting directly\n`);
    return undefined;
  }
}

export interface InstallProxyDeps {
  readonly setGlobalDispatcher: (dispatcher: Dispatcher) => void;
  readonly createProxyDispatcher: (env: Env) => Dispatcher | undefined;
}

const defaultInstallProxyDeps: InstallProxyDeps = {
  setGlobalDispatcher: undiciSetGlobalDispatcher,
  createProxyDispatcher,
};

/**
 * 将代理 dispatcher 安装为进程级 undici dispatcher，使所有 `fetch`
 * ——LLM SDK、进程内 MCP HTTP、遥测、OAuth、Web 工具、更新检查、下载
 * ——都遵守代理。在进程启动时、任何网络使用前调用一次。未设置代理变量时
 * 空操作（返回 `false`）。
 */
export function installGlobalProxyDispatcher(
  env: Env = process.env,
  deps: InstallProxyDeps = defaultInstallProxyDeps,
): boolean {
  const dispatcher = deps.createProxyDispatcher(env);
  if (dispatcher === undefined) return false;
  deps.setGlobalDispatcher(dispatcher);
  return true;
}

/**
 * 用于衍生子 Node 进程（如 stdio MCP 服务器）的环境变量补充，使其通过
 * Node 的 `--use-env-proxy` 原生遵守代理，无需打包 undici。进程内全局
 * dispatcher 不会跨进程边界继承——只有环境变量会——因此子进程依赖此函数。
 *
 * 仅适用于 HTTP/HTTPS 代理：Node 的 `--use-env-proxy` 不支持 SOCKS，
 * 因此仅 SOCKS 代理返回 `{}`（子进程 SOCKS 代理超出范围）。所有变量
 * 同时设置两种大小写：子进程继承父进程的环境变量，undici 优先读小写形式，
 * 因此小写变体也必须携带已解析的值，否则保护/代理会被静默丢失。
 *
 * 由于 `--use-env-proxy` 读取 `HTTP_PROXY`/`HTTPS_PROXY`（不读 `ALL_PROXY`），
 * http scheme 的 `ALL_PROXY` 会被合成为 scheme 特定变量，使仅设置了
 * `ALL_PROXY` 的父进程仍能代理子进程。
 */
export function proxyEnvForChild(env: Env = process.env): Record<string, string> {
  if (!hasHttpProxy(env)) return {};
  const noProxy = resolveNoProxy(env);
  const result: Record<string, string> = {
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  const { httpProxy, httpsProxy } = resolveHttpProxyUrls(env);
  if (httpProxy !== undefined) {
    result['HTTP_PROXY'] = httpProxy;
    result['http_proxy'] = httpProxy;
  }
  if (httpsProxy !== undefined) {
    result['HTTPS_PROXY'] = httpsProxy;
    result['https_proxy'] = httpsProxy;
  }
  return result;
}

/**
 * 将服务器配置的 `NO_PROXY` 覆盖同步到子进程环境变量的两种大小写形式。
 * undici 优先读小写 `no_proxy`，因此如果不这样做，{@link proxyEnvForChild}
 * 注入的另一种大小写形式的值会遮蔽显式的每服务器覆盖。
 *
 * 使用第一个非空大小写形式（空的 `no_proxy=''` 不应遮蔽有值的 `NO_PROXY`，
 * 与 {@link resolveNoProxy} 一致），并通过 {@link resolveNoProxy} 重新处理
 * 以保留回环绕过和 `*` 原样传递。配置未设置可用 `NO_PROXY` 时为空操作。
 */
export function reconcileChildNoProxy(
  childEnv: Record<string, string>,
  configEnv?: Record<string, string>,
): void {
  const override = [configEnv?.['no_proxy'], configEnv?.['NO_PROXY']].find(
    (value) => (value?.trim() ?? '').length > 0,
  );
  if (override === undefined) return;
  const noProxy = resolveNoProxy({ no_proxy: override, NO_PROXY: override });
  childEnv['NO_PROXY'] = noProxy;
  childEnv['no_proxy'] = noProxy;
}

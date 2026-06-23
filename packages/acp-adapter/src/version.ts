// ── 中文概述 ──
// 本模块负责 ACP 协议版本协商。
// 维护协议版本、规范标签、SDK 版本号的映射表。
// 在客户端初始化时，选择双方都支持的最高协议版本。

/**
 * ACP protocol version negotiation.
 *
 * Ported from kimi-cli/src/kimi_cli/acp/version.py. Tracks the (negotiation
 * integer, spec tag, SDK version) tuple per supported protocol revision and
 * picks the highest mutually-supported one when the client initializes.
 */

// 中文：ACP 版本规格接口，包含协议版本号、规范标签和 SDK 版本
export interface AcpVersionSpec {
  /** Negotiation integer used in InitializeRequest/Response. */
  readonly protocolVersion: number;
  /** ACP specification tag, e.g. "v0.10.x". */
  readonly specTag: string;
  /** Corresponding npm SDK semver string, e.g. "0.23.0". */
  readonly sdkVersion: string;
}

// 中文：当前服务器支持的 ACP 协议版本规格
export const CURRENT_VERSION: AcpVersionSpec = {
  protocolVersion: 1,
  specTag: 'v0.10.x',
  sdkVersion: '0.23.0',
};

// 中文：服务器支持的所有协议版本映射表，键为协议版本号
const SUPPORTED_VERSIONS: ReadonlyMap<number, AcpVersionSpec> = new Map([
  [1, CURRENT_VERSION],
]);

// 中文：服务器要求的最低协议版本号，低于此版本的客户端会被拒绝
export const MIN_PROTOCOL_VERSION = 1;

/**
 * Negotiate the protocol version with the client.
 *
 * Returns the highest server-supported version that does not exceed the
 * client's requested version. If the client version is lower than
 * {@link MIN_PROTOCOL_VERSION} the server still returns its own current
 * version so the client can decide whether to disconnect.
 */
// 中文：与客户端协商协议版本，返回双方都支持的最高版本
export function negotiateVersion(clientProtocolVersion: number): AcpVersionSpec {
  // 中文：客户端版本低于最低要求时，返回当前版本由客户端决定是否断开
  if (clientProtocolVersion < MIN_PROTOCOL_VERSION) {
    return CURRENT_VERSION;
  }

  // 中文：遍历支持的版本列表，找到不超过客户端版本的最高版本
  let best: AcpVersionSpec | undefined;
  for (const [ver, spec] of SUPPORTED_VERSIONS) {
    if (ver <= clientProtocolVersion && (best === undefined || ver > best.protocolVersion)) {
      best = spec;
    }
  }
  return best ?? CURRENT_VERSION;
}

import type { ExperimentalFeatureState, ExperimentalFlagMap } from '@moonshot-ai/kimi-code-sdk';

import { experimentalFeatureMap } from '#/utils/experimental-features';

// 已解析的实验性功能，在启动时通过 RPC 从核心获取一次，
// 然后由命令面板和分发同步读取。应用本地缓存，非权威数据源。
let snapshot: ExperimentalFlagMap = {};

/** 替换缓存的标志快照。在通过 `harness.getExperimentalFeatures()` 获取后调用。 */
export function setExperimentalFeatures(
  features: readonly Pick<ExperimentalFeatureState, 'id' | 'enabled'>[],
): void {
  snapshot = experimentalFeatureMap(features);
}

/** `undefined` 表示"未受门控" → 始终启用，因此调用方可传入可选的标志 ID。 */
export function isExperimentalFlagEnabled(flag: string | undefined): boolean {
  return flag === undefined || snapshot[flag] === true;
}

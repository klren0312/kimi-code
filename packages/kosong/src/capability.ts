/**
 * 特定模型的已声明能力。
 *
 * `getModelCapability(wire, model)` 返回其中之一，以便调用方可以在
 * 不发送请求并观察其在上游失败的情况下，根据模型不接受的模态
 * 来限制请求。
 *
 * `max_context_tokens: 0` 表示"未知"；不根据上下文长度进行限制的
 * 调用方可以忽略此字段。
 */
export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
}

const UNKNOWN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY');

/**
 * 当提供者未编目给定模型时返回的共享只读默认值。
 * 已冻结，以防某个调用点的意外修改泄漏到其他地方。
 */
export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze(
  Object.defineProperty(
    {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: false,
      max_context_tokens: 0,
    },
    UNKNOWN_CAPABILITY_MARKER,
    { value: true },
  ),
);

export function isUnknownCapability(capability: ModelCapability): boolean {
  if (capability === UNKNOWN_CAPABILITY) return true;
  const marked =
    (capability as unknown as Record<PropertyKey, unknown>)[UNKNOWN_CAPABILITY_MARKER] === true;
  if (marked) return true;
  return (
    !capability.image_in &&
    !capability.video_in &&
    !capability.audio_in &&
    !capability.thinking &&
    !capability.tool_use &&
    capability.max_context_tokens === 0
  );
}

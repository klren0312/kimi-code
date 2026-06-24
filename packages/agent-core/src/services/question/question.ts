/**
 * 问题服务接口 + 协议适配器。
 *
 * **服务接口**（`IQuestionService`）：Reverse-RPC 一次性代理角色——
 * 将 `KimiCore` 产出的 `QuestionRequest` 路由到等待方（通过 WS 的 web 客户端、
 * 测试中的 mock 处理器），并在响应到达时 resolve promise——或在用户关闭面板时
 * 执行 `dismiss()`（SCHEMAS.md §6.3）。
 *
 * 角色：一次性代理——参见 `packages/services/AGENTS.md`。按包范围约定保留 `Service`
 * 后缀；代理语义存在于接口形状（`request` + `resolve` + `dismiss`）和文档中，
 * 而非类型名称中。
 *
 * **形状说明：** 服务返回进程内
 * `QuestionResult = null | QuestionAnswers | QuestionResponse`（见
 * `packages/agent-core/src/rpc/sdk-api.ts:48`）。SCHEMAS.md §6.2/§6.4 定义了
 * 协议层 `QuestionResponse`，含 5 种判别联合体
 *（`single` / `multi` / `other` / `multi_with_other` / `skipped`）；
 * 协议↔进程内适配器位于守护进程边界，而非服务接口内部。这使适配器的 SDK 侧
 * 不受影响，并将协议形状决策限制在一个位置。
 *
 * **适配器**（`toBrokerRequest` / `toAgentCoreResponse` / `dismissedResult`）：
 * 桥接同一问题交互的两种表示：
 *
 *   1. **进程内 SDK 形状**（agent-core，驼峰式）——`BridgeClientAPI` 从
 *      `KimiCore.requestQuestion(...)` 获取的内容。见
 *      `packages/agent-core/src/rpc/sdk-api.ts:50-54`：
 *        `QuestionRequest { turnId?, toolCallId?, questions: QuestionItem[] }`
 *      其中 `QuestionItem` 含 `question, header?, body?, options[],
 *      multiSelect?, otherLabel?, otherDescription?`。
 *      `QuestionResult = null | QuestionAnswers | QuestionResponse`，
 *      `QuestionAnswers = Record<string, string | true>`。
 *
 *   2. **协议线协议形状**（下划线式，含守护进程分配的元数据）——
 *      定义在 `packages/protocol/src/question.ts`。5 种判别联合体：
 *      `single | multi | other | multi_with_other | skipped`。
 *
 * **合成稳定 id**（SDK 没有按项/按选项的 `id`）：
 *   - `QuestionItem.id`     ← `q_<index>`（如 `q_0`、`q_1`、...）
 *   - `QuestionOption.id`   ← `opt_<parent_idx>_<option_idx>`（如 `opt_0_0`）
 *
 * **防腐层**：这是问题交互中协议↔SDK 形状转换的唯一位置。
 */

import { createDecorator } from "../../di";
import type {
  QuestionAnswers as InProcessQuestionAnswers,
  QuestionItem as InProcessQuestionItem,
  QuestionRequest as InProcessQuestionRequest,
  QuestionRequest,
  QuestionResponse as InProcessQuestionResponse,
  QuestionResult,
} from "../../rpc";
import type {
  QuestionItem as ProtocolQuestionItem,
  QuestionOption as ProtocolQuestionOption,
  QuestionRequest as ProtocolQuestionRequest,
  QuestionResponse as ProtocolQuestionResponse,
} from "@moonshot-ai/protocol";
import type {} from "@moonshot-ai/protocol"; // type-only marker — keep protocol dep referenced

// 为服务端消费者重新导出。
export type { QuestionRequest, QuestionResult };

export interface IQuestionService {
  readonly _serviceBrand: undefined;

  /**
   * 当 KimiCore 需要用户回答问题时由适配器调用。
   * resolve 为进程内 `QuestionResult`（null = 无处理器/完全取消）。
   * 具体实现负责超时策略。
   */
  request(
    req: InProcessQuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult>;

  /**
   * 由应答端（REST 处理器/TUI/mock）调用，以用户回答结果结算待处理的 `request()`。
   * `id` 匹配 `QuestionRequest` 的关联 id（当前为 `turnId`+`toolCallId`；
   * 协议暴露后将使用 SCHEMAS.md §6.2 的 `question_id`）。
   */
  resolve(id: string, response: QuestionResult): void;

  /**
   * 当用户未回答即关闭面板时调用（ESC/关闭）。
   * 具体实现用 `dismissedQuestionResult()` 的等价值结算待处理的 `request()`
   *（`packages/agent-core`——见 SCHEMAS.md §6.3）。
   */
  dismiss(id: string): void;

  /**
   * 返回会话的协议形状待处理问题请求列表。
   * 会话状态生命周期用于检测 `awaiting_question` 状态。
   */
  listPending(sessionId: string): readonly ProtocolQuestionRequest[];
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IQuestionService =
  createDecorator<IQuestionService>("questionService");

// ---------------------------------------------------------------------------
// 适配器辅助函数（从 adapter/question-adapter.ts 迁移）
// ---------------------------------------------------------------------------

export interface QuestionToBrokerRequestParams {
  /** 守护进程分配的 ULID，标识此问题交互。 */
  readonly questionId: string;
  /** 问题所属的会话。 */
  readonly sessionId: string;
  /** `createdAt` ISO 字符串；代理传递 `new Date().toISOString()`。 */
  readonly createdAt: string;
  /** `expiresAt` ISO 字符串；代理计算 `createdAt + 60s`。 */
  readonly expiresAt: string;
}

/**
 * 从 SDK 选项构建协议选项。SDK 只有 `label?:string` + `description?:string`；
 * 我们从父级和子级索引合成 `id`，以便 `toAgentCoreAnswers` 能通过
 * `Record<qid, string>` 反向映射。
 */
function buildOption(
  opt: { readonly label: string; readonly description?: string },
  parentIdx: number,
  optIdx: number,
): ProtocolQuestionOption {
  const base: ProtocolQuestionOption = {
    id: `opt_${parentIdx}_${optIdx}`,
    label: opt.label,
  };
  return opt.description === undefined
    ? base
    : { ...base, description: opt.description };
}

/**
 * 从 SDK 项 + 其位置构建协议问题项。
 * 合成的 `id`（`q_<parentIdx>`）是 SDK 答案 Record 使用的键。
 */
function buildItem(
  item: InProcessQuestionItem,
  parentIdx: number,
): ProtocolQuestionItem {
  const id = `q_${parentIdx}`;
  const out: ProtocolQuestionItem = {
    id,
    question: item.question,
    options: item.options.map((o, oi) => buildOption(o, parentIdx, oi)),
  };
  if (item.header !== undefined) out.header = item.header;
  if (item.body !== undefined) out.body = item.body;
  if (item.multiSelect !== undefined) out.multi_select = item.multiSelect;
  // SDK has no allowOther field; always advertise the free-text Other option on the wire.
  out.allow_other = true;
  if (item.otherLabel !== undefined) out.other_label = item.otherLabel;
  if (item.otherDescription !== undefined)
    out.other_description = item.otherDescription;
  return out;
}

/**
 * 进程内 SDK 请求 + 守护进程分配的元数据 → 协议线协议形状。
 */
export function toBrokerRequest(
  req: InProcessQuestionRequest,
  params: QuestionToBrokerRequestParams,
): ProtocolQuestionRequest {
  const out: ProtocolQuestionRequest = {
    question_id: params.questionId,
    session_id: params.sessionId,
    questions: req.questions.map((q, i) => buildItem(q, i)),
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
  if (req.turnId !== undefined) out.turn_id = req.turnId;
  if (req.toolCallId !== undefined) out.tool_call_id = req.toolCallId;
  return out;
}

/**
 * 协议 REST 响应体 → 进程内 SDK `QuestionResponse`
 *（`answers` 展平为 `Record<string, string | true>`）。
 *
 * 来自 SCHEMAS §6.4 的规范化规则：
 *   - single            → option_id
 *   - multi             → option_ids.join(',')
 *   - other             → text
 *   - multi_with_other  → [...option_ids, other_text].join(',')
 *   - skipped           → 省略该条目
 */
export function toAgentCoreResponse(
  resp: ProtocolQuestionResponse,
): InProcessQuestionResponse {
  const flattened: InProcessQuestionAnswers = {};
  for (const [qid, ans] of Object.entries(resp.answers)) {
    switch (ans.kind) {
      case "single":
        flattened[qid] = ans.option_id;
        break;
      case "multi":
        flattened[qid] = ans.option_ids.join(",");
        break;
      case "other":
        flattened[qid] = ans.text;
        break;
      case "multi_with_other":
        flattened[qid] = [...ans.option_ids, ans.other_text].join(",");
        break;
      case "skipped":
        // 从记录中省略——符合 SCHEMAS §6.4（"if skipped continue"）。
        break;
      default: {
        // 防御性：如果 Zod schema 是 SOT 则永远不会到达，但 TS 窄化是穷举的，所以此处不可达。
        const _exhaustive: never = ans;
        void _exhaustive;
      }
    }
  }
  const out: InProcessQuestionResponse = { answers: flattened };
  if (resp.method !== undefined) {
    // SCHEMAS §6.2 协议允许 'click' 作为 method；agent-core 的进程内
    // `QuestionAnswerMethod` 为 `'enter' | 'space' | 'number_key'`（不含 'click'）。
    // 在进程内侧丢弃 'click' 以保持类型安全；线协议保留它供客户端呈现用户使用的交互方式。
    if (resp.method !== "click") {
      (out as { method?: typeof resp.method }).method = resp.method;
    }
  }
  return out;
}

/**
 * 便捷函数：SDK 中"取消整个问题组"的语义是 `null` QuestionResult。
 * 作为辅助函数暴露，使守护进程代码能以意图明确的方式读取，而非到处散落 `null` 常量。
 */
export function dismissedResult(): null {
  return null;
}

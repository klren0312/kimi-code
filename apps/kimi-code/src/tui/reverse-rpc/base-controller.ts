/**
 * 基于 Promise 的反向 RPC 对话控制器基类。
 *
 * 审批和问题流程在返回响应前等待用户操作。
 * 子类只需定义默认的取消响应。
 *
 * 当并发请求到达时（例如多个并行子代理各自需要审批），
 * 同一时间只显示一个面板；额外的请求按到达顺序排队，
 * 在当前请求解决后依次推进。
 */

export interface ReverseRpcUIHooks<TPayload> {
  showPanel(payload: TPayload): void;
  hidePanel(): void;
}

interface Pending<TPayload, TResponse> {
  readonly payload: TPayload;
  readonly resolve: (data: TResponse) => void;
}

export abstract class ReverseRpcController<TPayload, TResponse> {
  private uiHooks: ReverseRpcUIHooks<TPayload> | null = null;
  private current: Pending<TPayload, TResponse> | null = null;
  private queue: Array<Pending<TPayload, TResponse>> = [];

  setUIHooks(hooks: ReverseRpcUIHooks<TPayload>): void {
    this.uiHooks = hooks;
  }

  /**
   * 当核心发送反向 RPC 请求时调用。返回的 Promise 在用户响应
   * 或 `cancelAll` 强制取消后解决。
   */
  show(payload: TPayload): Promise<TResponse> {
    return new Promise<TResponse>((resolve) => {
      const entry: Pending<TPayload, TResponse> = { payload, resolve };
      if (this.current === null) {
        this.current = entry;
        this.uiHooks?.showPanel(payload);
      } else {
        this.queue.push(entry);
      }
    });
  }

  /** 用户在面板做出选择后由 UI 调用。 */
  respond(data: TResponse): void {
    const pending = this.current;
    this.current = null;
    pending?.resolve(data);
    if (pending !== null) {
      this.drainAutoResolved(pending.payload, data);
    }
    this.advanceOrHide();
  }

  /** 在关闭或会话切换时取消所有待处理请求。 */
  cancelAll(reason: string): void {
    const all = [...(this.current === null ? [] : [this.current]), ...this.queue];
    this.current = null;
    this.queue = [];
    this.uiHooks?.hidePanel();
    for (const entry of all) {
      entry.resolve(this.createCancelResponse(reason));
    }
  }

  hasPending(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  private advanceOrHide(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.uiHooks?.hidePanel();
      return;
    }
    this.current = next;
    this.uiHooks?.showPanel(next.payload);
  }

  private drainAutoResolved(resolvedPayload: TPayload, response: TResponse): void {
    const remaining: Array<Pending<TPayload, TResponse>> = [];
    for (const entry of this.queue) {
      const auto = this.autoResolveFor(resolvedPayload, response, entry.payload);
      if (auto === undefined) {
        remaining.push(entry);
      } else {
        entry.resolve(auto);
      }
    }
    this.queue = remaining;
  }

  /**
   * 子类可重写此方法，当刚解决的请求的回答（例如会话级审批）
   * 意味着匹配的排队请求也适用相同回答时，短路排队请求。
   * 返回 `undefined` 可让排队请求继续等待自己的面板轮次。
   */
  protected autoResolveFor(
    _resolvedPayload: TPayload,
    _response: TResponse,
    _queuedPayload: TPayload,
  ): TResponse | undefined {
    return undefined;
  }

  protected abstract createCancelResponse(reason: string): TResponse;
}

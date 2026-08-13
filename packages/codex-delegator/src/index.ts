import { CodexDelegator } from "./delegator.ts";

export { CodexDelegator, type CodexDelegatorOptions } from "./delegator.ts";
export { DelegatorError } from "./errors.ts";
export { DelegateEventCollector, decodeEvent } from "./events.ts";
export {
  JsonRpcTransport,
  type JsonRpcTransportOptions,
  type RpcTransport,
  type ServerRequest,
} from "./json-rpc.ts";
export { collectWorkspaceChanges } from "./changes.ts";
export { decodeAccountUsage } from "./usage.ts";
export { AttachmentStore, type StoredAttachment } from "./store.ts";
export type * from "./types.ts";

const delegate = new CodexDelegator();

export const probe = delegate.probe.bind(delegate);
export const connect = delegate.connect.bind(delegate);
export const create = delegate.create.bind(delegate);
export const turn = delegate.turn.bind(delegate);
export const resume = delegate.resume.bind(delegate);
export const steer = delegate.steer.bind(delegate);
export const review = delegate.review.bind(delegate);
export const cancel = delegate.cancel.bind(delegate);
export const inspect = delegate.inspect.bind(delegate);
export const usage = delegate.usage.bind(delegate);
export const close = delegate.close.bind(delegate);
export const closeAll = delegate.closeAll.bind(delegate);

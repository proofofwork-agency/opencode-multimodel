export class DelegatorError extends Error {
  constructor(
    readonly code:
      | "BACKEND_UNAVAILABLE"
      | "AUTH_UNAVAILABLE"
      | "CAPABILITY_UNAVAILABLE"
      | "INVALID_REQUEST"
      | "SESSION_BUSY"
      | "SESSION_CLOSED"
      | "TRANSPORT_ERROR"
      | "RATE_LIMITED"
      | "AMBIGUOUS_DELIVERY"
      | "CANCELLED"
      | "TIMED_OUT"
      | "OUTPUT_OVERFLOW",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DelegatorError";
  }
}

import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";

export type GatewayMethodClient = {
  request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function createGatewayMethodClient(): GatewayMethodClient {
  return {
    async request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
      const request = dispatchGatewayMethod(method, params) as Promise<unknown>;
      const response = options?.timeoutMs
        ? await Promise.race([
            request,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`gateway method timed out after ${options.timeoutMs}ms: ${method}`)), options.timeoutMs)),
          ])
        : await request;
      if (!response || typeof response !== "object" || !("ok" in response)) {
        throw new Error(`gateway method returned an invalid response: ${method}`);
      }
      const record = response as { ok: boolean; payload?: T; error?: { message?: string; code?: string } };
      if (!record.ok) {
        const code = record.error?.code ? `${record.error.code}: ` : "";
        throw new Error(`${method} failed: ${code}${record.error?.message ?? "unknown error"}`);
      }
      return record.payload as T;
    },
  };
}

export { errorMessage };

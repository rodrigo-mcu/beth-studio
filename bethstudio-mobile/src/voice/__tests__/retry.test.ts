import { ApiError, isRetryable, MAX_ATTEMPTS, retryDelayMs } from "../retry";

describe("retryDelayMs (mesma política do web: 2, 4, 8, 15, 30 s)", () => {
  it("segue a tabela e para em 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([2000, 4000, 8000, 15000, 30000, 30000, 30000]);
  });
  it("tolera valor negativo", () => {
    expect(retryDelayMs(-3)).toBe(2000);
  });
  it("são 6 tentativas", () => {
    expect(MAX_ATTEMPTS).toBe(6);
  });
});

describe("isRetryable", () => {
  it("repete rede, prazo, limite de uso e 5xx", () => {
    expect(isRetryable(new ApiError("sem rede", { kind: "network" }))).toBe(true);
    expect(isRetryable(new ApiError("prazo", { kind: "timeout" }))).toBe(true);
    expect(isRetryable(new ApiError("limite", { kind: "rate_limit" }))).toBe(true);
    expect(isRetryable(new ApiError("proxy", { status: 502 }))).toBe(true);
    expect(isRetryable(new ApiError("pc", { status: 503 }))).toBe(true);
    expect(isRetryable(new ApiError("depois", { status: 429 }))).toBe(true);
    expect(isRetryable(new ApiError("timeout", { status: 408 }))).toBe(true);
  });
  it("não repete erro que daria o mesmo resultado", () => {
    expect(isRetryable(new ApiError("chave", { kind: "auth" }))).toBe(false);
    expect(isRetryable(new ApiError("cancelado", { kind: "canceled" }))).toBe(false);
    expect(isRetryable(new ApiError("sem fala", { kind: "empty" }))).toBe(false);
    expect(isRetryable(new ApiError("somente leitura", { status: 403 }))).toBe(false);
    expect(isRetryable(new ApiError("tipo", { status: 415 }))).toBe(false);
    expect(isRetryable(new ApiError("senha", { status: 401 }))).toBe(false);
  });
  it("TypeError do fetch conta como rede; erro desconhecido não", () => {
    expect(isRetryable(new TypeError("Network request failed"))).toBe(true);
    expect(isRetryable(new Error("bug"))).toBe(false);
    expect(isRetryable("texto")).toBe(false);
  });
});

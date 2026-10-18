import {
  addPart,
  allPartsDone,
  completeTake,
  dueTakes,
  expedite,
  finishRecording,
  joinTexts,
  manualRetry,
  newTake,
  nextWakeAt,
  parseQueue,
  partDone,
  recoverInterrupted,
  sendFailed,
  startSending,
  type Take,
} from "../queue";
import { ApiError } from "../retry";

const T0 = 1_000_000;

function recorded(parts = 2): Take {
  let t = newTake("a", T0);
  for (let i = 0; i < parts; i++) t = addPart(t, { uri: `file:///takes/a-${i}.m4a`, seconds: 0, text: null });
  return finishRecording(t, 95, T0);
}

describe("gravação", () => {
  it("começa em 'recording' e guarda cada trecho assim que ele abre", () => {
    const t = addPart(newTake("a", T0), { uri: "file:///x.m4a", seconds: 0, text: null });
    expect(t.status).toBe("recording");
    expect(t.parts).toHaveLength(1);
  });

  it("ao parar vira 'pending', pronto para enviar já", () => {
    const t = recorded();
    expect(t.status).toBe("pending");
    expect(t.seconds).toBe(95);
    expect(t.nextAttemptAt).toBe(T0);
    expect(t.attempts).toBe(0);
  });
});

describe("envio com nova tentativa (2, 4, 8, 15, 30 s; 6 tentativas)", () => {
  it("falha repetível agenda a próxima tentativa e guarda o erro", () => {
    let t = startSending(recorded());
    expect(t.status).toBe("sending");
    t = sendFailed(t, new ApiError("sem rede", { kind: "network" }), T0);
    expect(t.status).toBe("pending");
    expect(t.attempts).toBe(1);
    expect(t.nextAttemptAt).toBe(T0 + 2000);
    expect(t.lastError).toBe("sem rede");
  });

  it("os atrasos seguem a tabela até a sexta falha, que desiste", () => {
    let t = recorded();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      t = sendFailed(startSending(t), new ApiError("x", { status: 503 }), T0);
      expect(t.status).toBe("pending");
      waits.push(t.nextAttemptAt - T0);
    }
    expect(waits).toEqual([2000, 4000, 8000, 15000, 30000]);
    t = sendFailed(startSending(t), new ApiError("x", { status: 503 }), T0);
    expect(t.status).toBe("failed");
    expect(t.attempts).toBe(6);
  });

  it("erro que não passa sozinho vai direto para 'failed'", () => {
    const t = sendFailed(startSending(recorded()), new ApiError("senha", { status: 401 }), T0);
    expect(t.status).toBe("failed");
    expect(t.lastError).toBe("senha");
  });

  it("Tentar de novo zera as tentativas e envia já", () => {
    let t = recorded();
    for (let i = 0; i < 6; i++) t = sendFailed(startSending(t), new ApiError("x", { kind: "network" }), T0);
    expect(t.status).toBe("failed");
    t = manualRetry(t, T0 + 99);
    expect(t.status).toBe("pending");
    expect(t.attempts).toBe(0);
    expect(t.nextAttemptAt).toBe(T0 + 99);
  });

  it("trecho que deu certo não é reenviado e zera as tentativas", () => {
    let t = sendFailed(startSending(recorded()), new ApiError("x", { kind: "network" }), T0);
    t = partDone(t, 0, " olá ");
    expect(t.parts[0]?.text).toBe("olá");
    expect(t.attempts).toBe(0);
    expect(allPartsDone(t)).toBe(false);
    t = partDone(t, 1, "mundo");
    expect(allPartsDone(t)).toBe(true);
  });
});

describe("texto final", () => {
  it("junta os trechos com espaço e ignora os vazios", () => {
    expect(joinTexts([{ uri: "a", seconds: 0, text: "olá" }, { uri: "b", seconds: 0, text: "" }, { uri: "c", seconds: 0, text: "mundo" }])).toBe("olá mundo");
  });

  it("completar põe o texto e o estado 'ready'", () => {
    let t = recorded();
    t = partDone(partDone(t, 0, "bom dia"), 1, "pessoal");
    t = completeTake(t);
    expect(t.status).toBe("ready");
    expect(t.text).toBe("bom dia pessoal");
  });

  it("sem fala em nenhum trecho: 'failed' (não repete), áudio continua guardado", () => {
    let t = recorded();
    t = partDone(partDone(t, 0, ""), 1, "  ");
    t = completeTake(t);
    expect(t.status).toBe("failed");
    expect(t.lastError).toMatch(/fala/);
  });
});

describe("fila", () => {
  it("só devolve o que já pode ser enviado, mais antigo primeiro", () => {
    const a = { ...recorded(), id: "a", createdAt: 5, nextAttemptAt: T0 + 5000 };
    const b = { ...recorded(), id: "b", createdAt: 3, nextAttemptAt: T0 };
    const c = { ...recorded(), id: "c", status: "failed" as const };
    const d = { ...recorded(), id: "d", status: "sending" as const };
    expect(dueTakes([a, b, c, d], T0 + 10).map((t) => t.id)).toEqual(["b"]);
    expect(dueTakes([a, b, c, d], T0 + 6000).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("próximo despertar é o menor nextAttemptAt entre os 'pending'", () => {
    const a = { ...recorded(), id: "a", nextAttemptAt: T0 + 9000 };
    const b = { ...recorded(), id: "b", nextAttemptAt: T0 + 3000 };
    const c = { ...recorded(), id: "c", status: "failed" as const, nextAttemptAt: 1 };
    expect(nextWakeAt([a, b, c])).toBe(T0 + 3000);
    expect(nextWakeAt([c])).toBeNull();
    expect(nextWakeAt([])).toBeNull();
  });

  it("app morto durante a gravação ou o envio: volta como 'pending' com os trechos", () => {
    const rec = addPart(newTake("r", T0), { uri: "file:///r-0.m4a", seconds: 0, text: null });
    const sending = startSending(recorded());
    const failed = { ...recorded(), id: "f", status: "failed" as const };
    const out = recoverInterrupted([rec, sending, failed], T0 + 50);
    expect(out.map((t) => t.status)).toEqual(["pending", "pending", "failed"]);
    expect(out[0]?.parts).toHaveLength(1);
    expect(out[0]?.nextAttemptAt).toBe(T0 + 50);
  });

  it("gravação interrompida sem nenhum trecho é descartada", () => {
    expect(recoverInterrupted([newTake("vazio", T0)], T0)).toEqual([]);
  });
});

describe("expedite (reconexão rápida)", () => {
  it("adianta só o que está esperando; o resto fica como está", () => {
    const wait = { ...recorded(), id: "w", nextAttemptAt: T0 + 30_000 };
    const failed = { ...recorded(), id: "f", status: "failed" as const, nextAttemptAt: T0 + 30_000 };
    const ready = { ...recorded(), id: "r", status: "ready" as const };
    const out = expedite([wait, failed, ready], T0 + 100);
    expect(out[0]?.nextAttemptAt).toBe(T0 + 100);
    expect(out[1]).toBe(failed);
    expect(out[2]).toBe(ready);
  });
  it("não atrasa quem já podia ser enviado", () => {
    const t = { ...recorded(), nextAttemptAt: T0 };
    expect(expedite([t], T0 + 500)[0]).toBe(t);
  });
});

describe("parseQueue", () => {
  it("lê o que foi salvo", () => {
    const q = [recorded()];
    expect(parseQueue(JSON.stringify(q))).toEqual(q);
  });
  it("aceita nulo, lixo e itens quebrados sem estourar", () => {
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue("{")).toEqual([]);
    expect(parseQueue('{"a":1}')).toEqual([]);
    const good = recorded();
    const raw = JSON.stringify([good, { id: 1 }, null, { ...good, id: "b", parts: [{ uri: 5 }] }, { ...good, id: "c", status: "voando" }]);
    expect(parseQueue(raw).map((t) => t.id)).toEqual(["a"]);
  });
});

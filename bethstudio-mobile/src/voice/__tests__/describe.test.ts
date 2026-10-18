import { clock, describeTake } from "../describe";
import { addPart, finishRecording, newTake, sendFailed, startSending, type Take } from "../queue";
import { ApiError } from "../retry";

const T0 = 9_000_000;
function base(): Take {
  return finishRecording(addPart(newTake("a", T0), { uri: "file:///a.m4a", seconds: 75, text: null }), 75, T0);
}

describe("clock", () => {
  it("formata mm:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7_400)).toBe("0:07");
    expect(clock(92_000)).toBe("1:32");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("describeTake", () => {
  it("na fila, antes de qualquer falha", () => {
    const d = describeTake(base(), T0);
    expect(d.title).toBe("Áudio de 1:15");
    expect(d.detail).toMatch(/fila|enviar/i);
    expect(d.actions).toEqual(["sendNow", "discard"]);
  });

  it("depois de uma falha mostra a contagem regressiva e o número da tentativa", () => {
    const t = sendFailed(startSending(base()), new ApiError("x", { kind: "network" }), T0);
    const d = describeTake(t, T0 + 500);
    expect(d.detail).toContain("2 s");
    expect(d.detail).toContain("tentativa 1 de 6");
    expect(d.detail).toMatch(/guardado/);
    expect(describeTake(t, T0 + 1500).detail).toContain("1 s");
    expect(describeTake(t, T0 + 99_000).detail).toContain("agora");
  });

  it("enviando não oferece ação", () => {
    expect(describeTake(startSending(base()), T0).actions).toEqual([]);
  });

  it("desistiu: mostra o motivo e as três saídas", () => {
    let t = base();
    for (let i = 0; i < 6; i++) t = sendFailed(startSending(t), new ApiError("O PC não respondeu", { status: 503 }), T0);
    const d = describeTake(t, T0);
    expect(d.detail).toContain("O PC não respondeu");
    expect(d.actions).toEqual(["retry", "download", "discard"]);
  });

  it("texto pronto: colocar no campo, copiar, descartar", () => {
    const t: Take = { ...base(), status: "ready", text: "olá" };
    const d = describeTake(t, T0);
    expect(d.title).toBe("Texto pronto");
    expect(d.preview).toBe("olá");
    expect(d.actions).toEqual(["place", "copy", "discard"]);
  });

  it("gravação interrompida pelo sistema", () => {
    const t = { ...base(), status: "recording" as const };
    expect(describeTake(t, T0).detail).toMatch(/interromp/i);
  });
});

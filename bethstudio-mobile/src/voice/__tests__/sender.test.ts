import { addPart, finishRecording, newTake, type Take } from "../queue";
import { ApiError } from "../retry";
import { processTake } from "../sender";

const T0 = 5_000_000;

function take(texts: (string | null)[] = [null, null]): Take {
  let t = newTake("a", T0);
  texts.forEach((text, i) => {
    t = addPart(t, { uri: `file:///a-${i}.m4a`, seconds: 60, text });
  });
  return finishRecording(t, 120, T0);
}

describe("processTake", () => {
  it("envia os trechos em ordem, salva a cada trecho e termina 'ready' com o texto junto", async () => {
    const saved: Take[] = [];
    const order: string[] = [];
    const out = await processTake(take(), {
      now: () => T0,
      transcribe: async (uri) => {
        order.push(uri);
        return uri.endsWith("0.m4a") ? "bom dia" : "time";
      },
      save: async (t) => {
        saved.push(t);
      },
    });
    expect(order).toEqual(["file:///a-0.m4a", "file:///a-1.m4a"]);
    expect(out.status).toBe("ready");
    expect(out.text).toBe("bom dia time");
    // salvou 'sending', depois cada trecho, depois o final
    expect(saved.map((t) => t.status)).toEqual(["sending", "sending", "sending", "ready"]);
    expect(saved[1]?.parts[0]?.text).toBe("bom dia");
  });

  it("pula trecho já transcrito (retomada depois de falha)", async () => {
    const seen: string[] = [];
    const out = await processTake(take(["pronto", null]), {
      now: () => T0,
      transcribe: async (uri) => {
        seen.push(uri);
        return "resto";
      },
      save: async () => undefined,
    });
    expect(seen).toEqual(["file:///a-1.m4a"]);
    expect(out.text).toBe("pronto resto");
  });

  it("falha repetível no segundo trecho: guarda o primeiro e agenda nova tentativa", async () => {
    const out = await processTake(take(), {
      now: () => T0,
      transcribe: async (uri) => {
        if (uri.endsWith("1.m4a")) throw new ApiError("sem rede", { kind: "network" });
        return "primeiro";
      },
      save: async () => undefined,
    });
    expect(out.status).toBe("pending");
    expect(out.parts[0]?.text).toBe("primeiro");
    expect(out.parts[1]?.text).toBeNull();
    expect(out.attempts).toBe(1);
    expect(out.nextAttemptAt).toBe(T0 + 2000);
  });

  it("senha errada: 'failed' na hora", async () => {
    const out = await processTake(take(), {
      now: () => T0,
      transcribe: async () => {
        throw new ApiError("Senha incorreta.", { kind: "auth", status: 401 });
      },
      save: async () => undefined,
    });
    expect(out.status).toBe("failed");
    expect(out.lastError).toBe("Senha incorreta.");
  });

  it("tudo sem fala: 'failed' com o áudio guardado", async () => {
    const out = await processTake(take(), { now: () => T0, transcribe: async () => "  ", save: async () => undefined });
    expect(out.status).toBe("failed");
    expect(out.parts).toHaveLength(2);
  });

  it("se salvar o progresso falhar, o envio continua (o áudio nunca se perde)", async () => {
    const out = await processTake(take(), {
      now: () => T0,
      transcribe: async () => "ok",
      save: async () => {
        throw new Error("disco cheio");
      },
    });
    expect(out.status).toBe("ready");
  });
});

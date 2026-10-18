import { SegmentedRecorder, type RecorderLike } from "../segmented";

class FakeRecorder implements RecorderLike {
  static all: FakeRecorder[] = [];
  uri: string;
  currentTime = 0;
  recording = false;
  stopped = false;
  metering: number | undefined = -20;
  constructor(public n: number) {
    this.uri = `file:///seg-${n}.m4a`;
    FakeRecorder.all.push(this);
  }
  async prepareToRecordAsync() {}
  record() {
    this.recording = true;
  }
  async stop() {
    this.recording = false;
    this.stopped = true;
  }
  getStatus() {
    return { metering: this.metering };
  }
}

function setup(segmentMs = 60_000) {
  FakeRecorder.all = [];
  let n = 0;
  let clock = 1_000;
  const opened: string[] = [];
  const closed: { uri: string; seconds: number }[] = [];
  const rec = new SegmentedRecorder({
    create: () => new FakeRecorder(n++),
    segmentMs,
    now: () => clock,
    onSegmentOpen: async (uri) => {
      opened.push(uri);
    },
    onSegmentClosed: async (p) => {
      closed.push(p);
    },
  });
  return { rec, opened, closed, advance: (ms: number) => (clock += ms) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("SegmentedRecorder", () => {
  it("grava um trecho e avisa o caminho ANTES de começar (para a fila já conhecer o arquivo)", async () => {
    const { rec, opened } = setup();
    await rec.start();
    expect(opened).toEqual(["file:///seg-0.m4a"]);
    expect(FakeRecorder.all[0]?.recording).toBe(true);
  });

  it("parar fecha o trecho e devolve a duração total", async () => {
    const { rec, closed, advance } = setup();
    await rec.start();
    advance(8_500);
    const r = await rec.stop();
    expect(closed).toEqual([{ uri: "file:///seg-0.m4a", seconds: 8.5 }]);
    expect(r.seconds).toBe(8.5);
    expect(r.parts).toHaveLength(1);
    expect(FakeRecorder.all[0]?.stopped).toBe(true);
  });

  it("a cada segmentMs fecha o trecho e abre o próximo sem parar a gravação", async () => {
    const { rec, opened, closed, advance } = setup(60_000);
    await rec.start();
    advance(60_000);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(closed.map((c) => c.uri)).toEqual(["file:///seg-0.m4a"]);
    expect(opened).toEqual(["file:///seg-0.m4a", "file:///seg-1.m4a"]);
    expect(FakeRecorder.all[1]?.recording).toBe(true);
    advance(20_000);
    const r = await rec.stop();
    expect(r.parts.map((p) => p.uri)).toEqual(["file:///seg-0.m4a", "file:///seg-1.m4a"]);
    expect(r.seconds).toBe(80);
  });

  it("guarda o maior pico do medidor", async () => {
    const { rec } = setup();
    await rec.start();
    const fake = FakeRecorder.all[0];
    if (fake) fake.metering = -12;
    rec.sampleLevel();
    if (fake) fake.metering = -40;
    rec.sampleLevel();
    const r = await rec.stop();
    expect(r.peakDb).toBe(-12);
  });

  it("cancelar pára e devolve os trechos, para o dono apagar os arquivos", async () => {
    const { rec } = setup();
    await rec.start();
    const r = await rec.cancel();
    expect(r.parts).toHaveLength(1);
    expect(FakeRecorder.all[0]?.stopped).toBe(true);
  });

  it("se a rotação falhar, o trecho atual continua gravando e a gravação não se perde", async () => {
    FakeRecorder.all = [];
    let n = 0;
    let clock = 0;
    const closed: string[] = [];
    const rec = new SegmentedRecorder({
      create: () => {
        const f = new FakeRecorder(n++);
        if (f.n === 1) f.prepareToRecordAsync = async () => Promise.reject(new Error("microfone ocupado"));
        return f;
      },
      segmentMs: 10_000,
      now: () => clock,
      onSegmentOpen: async () => undefined,
      onSegmentClosed: async (p) => {
        closed.push(p.uri);
      },
    });
    await rec.start();
    clock = 10_000;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(FakeRecorder.all[0]?.recording).toBe(true);
    expect(closed).toEqual([]);
    clock = 12_000;
    const r = await rec.stop();
    expect(r.parts).toHaveLength(1);
    expect(r.seconds).toBe(12);
  });
});

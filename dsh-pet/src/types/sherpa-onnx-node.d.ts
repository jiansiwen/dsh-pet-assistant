/**
 * sherpa-onnx-node 的最小类型面（官方包只带 JSDoc，没有 .d.ts）。
 * 只声明本项目用到的部分 —— 用到一个补一个，不照抄上游。
 *
 * 两套识别器都在这里：流式（OnlineRecognizer，说一个字出一个字）与整句
 * （OfflineRecognizer，SenseVoice 说完整句再转）。**两条都在进程内跑**，
 * 不 spawn 任何外部可执行文件 —— 这是跨平台的关键，见 `src/main/asr.ts` 的文件头。
 */
declare module 'sherpa-onnx-node' {
  // ===== 流式（OnlineRecognizer）=====

  interface OnlineTransducerModelConfig {
    encoder: string
    decoder: string
    joiner: string
  }

  interface OnlineModelConfig {
    transducer: OnlineTransducerModelConfig
    tokens: string
    numThreads?: number
    debug?: boolean | number
  }

  interface OnlineRecognizerConfig {
    modelConfig: OnlineModelConfig
    decodingMethod?: string
    enableEndpoint?: boolean | number
  }

  interface OnlineStream {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
    inputFinished(): void
  }

  interface OnlineRecognizerResult {
    text: string
  }

  export class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    getResult(stream: OnlineStream): OnlineRecognizerResult
    reset(stream: OnlineStream): void
  }

  // ===== 整句（OfflineRecognizer）=====

  /**
   * SenseVoice 的配置项。
   *
   * `language: 'auto'` 让它自己判断语种；`useInverseTextNormalization: 1` 把
   * "二零二六年" 之类还原成数字写法（1/0 而不是布尔 —— C API 收的是整数）。
   */
  interface OfflineSenseVoiceModelConfig {
    model: string
    language?: string
    useInverseTextNormalization?: number
  }

  interface OfflineModelConfig {
    senseVoice: OfflineSenseVoiceModelConfig
    tokens: string
    numThreads?: number
    debug?: boolean | number
  }

  interface OfflineRecognizerConfig {
    modelConfig: OfflineModelConfig
    decodingMethod?: string
  }

  interface OfflineStream {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void
  }

  /**
   * 识别结果。`text` 之外的字段（lang / emotion / event / timestamps）SenseVoice 会给，
   * 本项目只用 `text`；留着 `[key: string]: unknown` 是为了不阻碍将来取用。
   */
  interface OfflineRecognizerResult {
    text: string
    lang?: string
    emotion?: string
    event?: string
    [key: string]: unknown
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig)
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): OfflineRecognizerResult
  }

  // ===== 重采样 =====

  /**
   * 线性重采样器。录音的设备默认采样率不一定是 16kHz（渲染层刻意不指定采样率），
   * 而 SenseVoice 只吃 16kHz —— 换算交给它，不自己写插值：
   * 采样率算错只会让识别变差，不会报错，是最难发现的一类 bug。
   *
   * 最后一块要调 `flush`（把内部缓冲的尾巴吐出来），不是 `resample`。
   */
  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number)
    resample(samples: Float32Array): Float32Array
    flush(samples: Float32Array): Float32Array
    reset(): void
  }

  const _default: {
    OnlineRecognizer: typeof OnlineRecognizer
    OfflineRecognizer: typeof OfflineRecognizer
    LinearResampler: typeof LinearResampler
  }
  export default _default

  /**
   * 实例类型别名。
   *
   * `sherpa.OfflineRecognizer` 这种写法**不成立**：`sherpa` 是个值（默认导出对象），
   * 不是命名空间，所以拿不到它的类型成员。`import sherpa from ...` 之后想标注实例类型，
   * 只能靠这里导出的别名 —— 或者用 `InstanceType<typeof sherpa.OfflineRecognizer>`，
   * 后者能写但很长。给两个都留上，调用方挑顺手的。
   */
  export type OfflineRecognizerInstance = OfflineRecognizer
  export type OnlineRecognizerInstance = OnlineRecognizer
}

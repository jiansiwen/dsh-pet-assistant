/**
 * sherpa-onnx-node 的最小类型面（官方包只带 JSDoc，没有 .d.ts）。
 * 只声明本项目用到的部分 —— 用到一个补一个，不照抄上游。
 *
 * 两套识别器都在这里：流式（OnlineRecognizer，说一个字出一个字）与整句
 * （OfflineRecognizer，SenseVoice 说完整句再转）。**两条都在进程内跑**，
 * 不 spawn 任何外部可执行文件 —— 这是跨平台的关键，见 `src/main/asr.ts` 的文件头。
 * 会议的说话人分离（OfflineSpeakerDiarization）见 `src/main/diarize.ts`。
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

  // ===== 说话人分离（OfflineSpeakerDiarization，会议会后精修用）=====

  /**
   * pyannote segmentation-3.0。`windowShiftRatio` 是 10 秒分析窗的步长比例（默认 0.1）：
   * 步长越大窗口越少、嵌入提取次数越少，速度近似成比例变快，边界精度略降。
   */
  interface OfflineSpeakerSegmentationPyannoteModelConfig {
    model: string
    windowShiftRatio?: number
  }

  interface OfflineSpeakerSegmentationModelConfig {
    pyannote: OfflineSpeakerSegmentationPyannoteModelConfig
    numThreads?: number
    debug?: boolean | number
    provider?: string
  }

  interface SpeakerEmbeddingExtractorConfig {
    model: string
    numThreads?: number
    debug?: boolean | number
    provider?: string
  }

  /** numClusters = -1 表示人数未知，此时按 threshold 聚类：阈值越大，分出的人越少。 */
  interface FastClusteringConfig {
    numClusters?: number
    threshold?: number
  }

  export interface OfflineSpeakerDiarizationConfig {
    segmentation: OfflineSpeakerSegmentationModelConfig
    embedding: SpeakerEmbeddingExtractorConfig
    clustering?: FastClusteringConfig
    /** 短于它（秒）的段丢弃。 */
    minDurationOn?: number
    /** 同一说话人两段间隔短于它（秒）就并成一段。 */
    minDurationOff?: number
  }

  /** 一段分离结果：秒为单位，speaker 是本次运行内的聚类编号（不稳定，跨运行不可比）。 */
  export interface SpeakerDiarizationSegment {
    start: number
    end: number
    speaker: number
  }

  /**
   * 整段音频一次性分离（需要全局聚类，不能流式）。`process` 是**同步**原生调用，
   * 几十秒的音频就要跑数秒——主进程里直接调会卡住界面，要放到 Worker 里跑。
   * 只输出时间段与编号，不暴露也不保存声纹嵌入。
   */
  export class OfflineSpeakerDiarization {
    constructor(config: OfflineSpeakerDiarizationConfig)
    readonly sampleRate: number
    process(samples: Float32Array): SpeakerDiarizationSegment[]
    setConfig(config: { clustering: FastClusteringConfig }): void
  }

  // ===== 唤醒词（KeywordSpotter，M1-02）=====

  /** 关键词检出器。模型是一个很小的流式 transducer，解码端加了关键词约束。 */
  export interface KeywordSpotterConfig {
    featConfig?: { sampleRate?: number; featureDim?: number }
    modelConfig: OnlineModelConfig & { provider?: string }
    maxActivePaths?: number
    numTrailingBlanks?: number
    keywordsScore?: number
    keywordsThreshold?: number
    keywordsFile: string
  }

  export interface KeywordResult {
    start_time?: number
    keyword: string
    timestamps?: number[]
    tokens?: string[]
  }

  export class KeywordSpotter {
    constructor(config: KeywordSpotterConfig)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    reset(stream: OnlineStream): void
    getResult(stream: OnlineStream): KeywordResult
  }

  const _default: {
    OnlineRecognizer: typeof OnlineRecognizer
    OfflineRecognizer: typeof OfflineRecognizer
    LinearResampler: typeof LinearResampler
    OfflineSpeakerDiarization: typeof OfflineSpeakerDiarization
    KeywordSpotter: typeof KeywordSpotter
  }
  export default _default

  export type OfflineSpeakerDiarizationInstance = OfflineSpeakerDiarization

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

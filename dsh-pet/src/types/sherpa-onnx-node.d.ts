/**
 * sherpa-onnx-node 的最小类型面（官方包只带 JSDoc，没有 .d.ts）。
 * 只声明本项目用到的部分。
 */
declare module 'sherpa-onnx-node' {
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

  const _default: { OnlineRecognizer: typeof OnlineRecognizer }
  export default _default
}

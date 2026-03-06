import { createSocket, type Socket } from 'node:dgram';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

import type {
  CameraController,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  CameraStreamingDelegate,
  HDSProtocolSpecificErrorReason,
  PlatformAccessory,
  PrepareStreamRequest,
  PrepareStreamResponse,
  RecordingPacket,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamRequestCallback,
  StreamingRequest,
} from 'homebridge';

import type { AccessoryDeviceContext, BambuPlatform } from './platform.js';

const MOTION_FRAME_BYTES = 64 * 36;
const RELAY_FPS = 15;
const RELAY_BITRATE_KBPS = 1500;
const RELAY_GOP = RELAY_FPS;
const SNAPSHOT_INTERVAL_FPS = 0.2;
const SNAPSHOT_MAX_AGE_MS = 60_000;
const SNAPSHOT_STALE_WARN_MS = 30_000;

interface CameraSessionInfo {
  videoSSRC: number;
  videoCryptoSuite: number;
  targetAddress: string;
  targetVideoPort: number;
  videoKey: Buffer;
  videoSalt: Buffer;
}

interface Mp4BoxInfo {
  box: Buffer;
  boxType: string;
  bytesConsumed: number;
}

interface PrebufferFragment {
  timestamp: number;
  data: Buffer;
}

interface RecordingConsumer {
  streamId: number;
  queue: RecordingPacket[];
  waiters: Array<() => void>;
  closed: boolean;
  endRequestedAt?: number;
  endAfterNextFragment: boolean;
}

export class BambuCameraAccessory implements CameraStreamingDelegate, CameraRecordingDelegate {
  private readonly context: AccessoryDeviceContext;
  private readonly controller: CameraController;

  private readonly relayPort: number;
  private readonly snapshotTmpPath: string;

  private readonly pendingSessions = new Map<string, CameraSessionInfo>();
  private readonly ongoingSessions = new Map<string, ChildProcess>();
  private readonly returnSockets = new Map<string, Socket>();
  private readonly stoppingSessions = new Set<string>();

  private recordingActive = false;
  private recordingConfig?: CameraRecordingConfiguration;

  private unifiedProcess?: ChildProcess;
  private unifiedStdoutIsHksv = false;
  private unifiedHasPipe3Motion = false;
  private unifiedRestartTimer?: NodeJS.Timeout;

  private recordingParserBuffer = Buffer.alloc(0);
  private recordingInitAccumulation = Buffer.alloc(0);
  private recordingInitSegment?: Buffer;
  private recordingCurrentFragment = Buffer.alloc(0);
  private readonly prebufferFragments: PrebufferFragment[] = [];
  private readonly recordingConsumers = new Map<number, RecordingConsumer>();
  private recordingMonitorTimer?: NodeJS.Timeout;

  private motionFrameBuffer = Buffer.alloc(0);
  private previousMotionFrame?: Buffer;
  private motionDetected = false;
  private motionTriggerUntil = 0;
  private motionResetTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: BambuPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.context = accessory.context.device as AccessoryDeviceContext;

    const serialNumber = this.platform.getPrinterSerialNumber(this.context.printerId);
    const serialHash = serialNumber.split('').reduce((acc: number, current: string) => acc + current.charCodeAt(0), 0);
    this.relayPort = 20000 + (serialHash % 10000);
    this.snapshotTmpPath = this.platform.getStoragePath(`bambu-${serialNumber}-snapshot.jpg`);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bambu Lab')
      .setCharacteristic(this.platform.Characteristic.Model, this.platform.getPrinterModel(this.context.printerId))
      .setCharacteristic(this.platform.Characteristic.SerialNumber, serialNumber);

    const hksvEnabled = this.platform.isHksvEnabled(this.context.printerId);

    const controllerOptions: ConstructorParameters<typeof this.platform.api.hap.CameraController>[0] = {
      cameraStreamCount: hksvEnabled ? 4 : 6,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [
          this.platform.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
        ],
        video: {
          codec: {
            profiles: [
              this.platform.api.hap.H264Profile.BASELINE,
              this.platform.api.hap.H264Profile.MAIN,
              this.platform.api.hap.H264Profile.HIGH,
            ],
            levels: [
              this.platform.api.hap.H264Level.LEVEL3_1,
              this.platform.api.hap.H264Level.LEVEL3_2,
              this.platform.api.hap.H264Level.LEVEL4_0,
            ],
          },
          resolutions: [
            [320, 240, 15],
            [320, 180, 15],
            [640, 360, 20],
            [1280, 720, 30],
            [1920, 1080, 24],
          ],
        },
      },
    };

    if (hksvEnabled) {
      controllerOptions.recording = {
        delegate: this,
        options: {
          prebufferLength: this.platform.getHksvPrebufferLengthMs(this.context.printerId),
          mediaContainerConfiguration: {
            type: this.platform.api.hap.MediaContainerType.FRAGMENTED_MP4,
            fragmentLength: this.platform.getHksvFragmentLengthMs(this.context.printerId),
          },
          video: {
            type: this.platform.api.hap.VideoCodecType.H264,
            parameters: {
              profiles: [
                this.platform.api.hap.H264Profile.BASELINE,
                this.platform.api.hap.H264Profile.MAIN,
                this.platform.api.hap.H264Profile.HIGH,
              ],
              levels: [
                this.platform.api.hap.H264Level.LEVEL3_1,
                this.platform.api.hap.H264Level.LEVEL3_2,
                this.platform.api.hap.H264Level.LEVEL4_0,
              ],
            },
            resolutions: [
              [1280, 720, 15],
              [1280, 720, 24],
              [1920, 1080, 15],
              [1920, 1080, 24],
            ],
          },
          audio: {
            codecs: {
              type: this.platform.api.hap.AudioRecordingCodecType.AAC_LC,
              audioChannels: 1,
              bitrateMode: this.platform.api.hap.AudioBitrate.VARIABLE,
              samplerate: this.platform.api.hap.AudioRecordingSamplerate.KHZ_32,
            },
          },
        },
      };
    }

    if (this.platform.shouldExposeMotionSensor(this.context.printerId)) {
      controllerOptions.sensors = { motion: true };
    }

    this.controller = new this.platform.api.hap.CameraController(controllerOptions);
    this.accessory.configureController(this.controller);

    this.accessory.on('identify', () => {
      this.platform.log.info(`${this.context.displayName} identified!`);
    });

    this.updateMotionDetected(false);

    if (hksvEnabled) {
      this.startRecordingMonitor();
    }

    this.updateUnifiedPipelineState();
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const width = request.width > 0 ? request.width : 1280;
    const height = request.height > 0 ? request.height : 720;

    this.platform.log.info(`Snapshot request ${width}x${height}`);

    if (existsSync(this.snapshotTmpPath)) {
      try {
        const ageMs = Date.now() - statSync(this.snapshotTmpPath).mtimeMs;
        if (ageMs < SNAPSHOT_MAX_AGE_MS) {
          if (ageMs >= SNAPSHOT_STALE_WARN_MS) {
            this.platform.log.warn(`Snapshot cache is stale (${Math.round(ageMs / 1000)}s old); returning it anyway.`);
          }

          const data = readFileSync(this.snapshotTmpPath);
          this.platform.log.info(`Snapshot from cache (${data.length} bytes, ${Math.round(ageMs / 1000)}s old)`);
          callback(undefined, data);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.platform.log.debug(`Unable to reuse cached snapshot: ${message}`);
      }
    }

    const pipelineRunning = this.unifiedProcess != null;
    const streamUrl = this.platform.getCameraStreamUrl(this.context.printerId);

    if (!pipelineRunning && !streamUrl) {
      callback(new Error('Camera stream URL is not configured.'));
      return;
    }

    const sourceUrl = pipelineRunning
      ? `udp://127.0.0.1:${this.relayPort}?overrun_nonfatal=1&fifo_size=5000000`
      : streamUrl!;

    const extraInputArgs = pipelineRunning ? [] : ['-rtsp_transport', 'tcp', '-timeout', '10000000'];

    const ffmpegPath = this.platform.getFfmpegPath(this.context.printerId);
    const snapshotTimeoutMs = 14000;

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      ...extraInputArgs,
      '-i', sourceUrl,
      '-frames:v', '1',
      '-vf', `scale=${width}:${height}`,
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];

    this.platform.log.info(`Snapshot ffmpeg args: ${args.join(' ')}`);

    const ffmpegProcess = spawn(ffmpegPath, args, { env: process.env });

    const chunks: Buffer[] = [];
    let stderr = '';
    let completed = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        timedOut = true;
        ffmpegProcess.kill('SIGKILL');
      }
    }, snapshotTimeoutMs);

    ffmpegProcess.stdout.on('data', (data: Buffer) => chunks.push(data));
    ffmpegProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpegProcess.on('close', (code) => {
      completed = true;
      clearTimeout(timeout);

      if (code === 0 && chunks.length > 0) {
        this.platform.log.info(`Snapshot success ${width}x${height} (${Buffer.concat(chunks).length} bytes)`);
        callback(undefined, Buffer.concat(chunks));
        return;
      }

      const details = stderr.trim();
      if (timedOut) {
        this.platform.log.error(`Snapshot timed out after ${snapshotTimeoutMs}ms (${width}x${height})`);
      } else if (details.length > 0) {
        this.platform.log.error(`Snapshot ffmpeg failed code=${code}: ${details}`);
      } else {
        this.platform.log.error(`Snapshot ffmpeg failed code=${code}`);
      }

      callback(new Error(`Snapshot ffmpeg exited code=${code}. ${stderr.trim()}`));
    });

    ffmpegProcess.on('error', (error) => {
      completed = true;
      clearTimeout(timeout);
      this.platform.log.error(`Snapshot ffmpeg spawn error: ${error.message}`);
      callback(error);
    });
  }

  prepareStream(
    request: PrepareStreamRequest,
    callback: (error?: Error | undefined, response?: PrepareStreamResponse | undefined) => void,
  ): void {
    void this.prepareStreamInternal(request, callback);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const sessionId = request.sessionID;

    switch (request.type) {
    case this.platform.api.hap.StreamRequestTypes.START: {
      this.stopOtherSessions(sessionId);

      const sessionInfo = this.pendingSessions.get(sessionId);
      if (!sessionInfo) {
        callback(new Error(`Missing session information for ${sessionId}`));
        return;
      }

      const pipelineRunning = this.unifiedProcess != null;
      const streamUrl = this.platform.getCameraStreamUrl(this.context.printerId);

      if (!pipelineRunning && !streamUrl) {
        callback(new Error('Camera stream URL is not configured.'));
        return;
      }

      const sourceInputArgs = pipelineRunning
        ? ['-i', `udp://127.0.0.1:${this.relayPort}?overrun_nonfatal=1&fifo_size=5000000`]
        : ['-rtsp_transport', 'tcp', '-i', streamUrl!];

      const ffmpegPath = this.platform.getFfmpegPath(this.context.printerId);
      const videoInfo = request.video;
      const outputWidth = Math.max(320, Math.min(1920, videoInfo.width));
      const outputHeight = Math.max(180, Math.min(1080, videoInfo.height));
      const outputFps = Math.max(10, Math.min(30, videoInfo.fps));
      const maxBitrate = Math.max(300, Math.min(2000, videoInfo.max_bit_rate));
      const packetSize = this.sanitizePacketSize(videoInfo.mtu);
      const targetHost = this.formatTargetHost(sessionInfo.targetAddress);
      const h264Profile = this.toH264ProfileString(videoInfo.profile);
      const h264Level = this.toH264LevelString(videoInfo.level);
      const videoCodec = this.platform.getCameraVideoCodec(this.context.printerId);

      if (!h264Profile || !h264Level) {
        callback(new Error(`Unsupported H.264 profile/level: ${videoInfo.profile}/${videoInfo.level}`));
        return;
      }

      const srtpSuite = this.toSrtpSuiteString(sessionInfo.videoCryptoSuite);
      if (!srtpSuite) {
        callback(new Error(`Unsupported SRTP crypto suite: ${sessionInfo.videoCryptoSuite}`));
        return;
      }

      const srtpParams = Buffer.concat([sessionInfo.videoKey, sessionInfo.videoSalt]).toString('base64');
      const gop = Math.max(20, Math.min(60, outputFps * 2));
      const codecSpecificArgs = videoCodec === 'libx264'
        ? ['-preset', 'ultrafast', '-tune', 'zerolatency', '-x264-params', 'aud=1:repeat-headers=1', '-sc_threshold', '0']
        : ['-realtime', '1'];

      const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        ...sourceInputArgs,
        '-an',
        '-sn',
        '-map', '0:v:0',
        '-codec:v', videoCodec,
        ...codecSpecificArgs,
        '-profile:v', h264Profile,
        '-level:v', h264Level,
        '-pix_fmt', 'yuv420p',
        '-r', `${outputFps}`,
        '-vf', `scale=${outputWidth}:${outputHeight}`,
        '-b:v', `${maxBitrate}k`,
        '-bufsize', `${maxBitrate * 2}k`,
        '-maxrate', `${maxBitrate}k`,
        '-g', `${gop}`,
        '-keyint_min', `${Math.max(10, Math.floor(gop / 2))}`,
        '-muxdelay', '0',
        '-muxpreload', '0',
        '-payload_type', `${videoInfo.pt}`,
        '-ssrc', `${sessionInfo.videoSSRC}`,
        '-f', 'rtp',
        '-srtp_out_suite', srtpSuite,
        '-srtp_out_params', srtpParams,
        `srtp://${targetHost}:${sessionInfo.targetVideoPort}`
        + `?rtcpport=${sessionInfo.targetVideoPort}`
        + `&pkt_size=${packetSize}`,
      ];

      this.platform.log.info(`Starting camera stream (${sessionId}) via ${pipelineRunning ? 'relay' : 'direct'}`);
      this.platform.log.info(`Camera ffmpeg args (${sessionId}): ${args.join(' ')}`);

      const ffmpegProcess = spawn(ffmpegPath, args, { env: process.env });
      this.ongoingSessions.set(sessionId, ffmpegProcess);
      this.pendingSessions.delete(sessionId);

      let stderrBuffer = '';

      ffmpegProcess.stderr.on('data', (data: Buffer) => {
        const message = data.toString().trim();
        if (message.length > 0) {
          stderrBuffer = (stderrBuffer + '\n' + message).slice(-4000);
          this.platform.log.info(`Camera ffmpeg (${sessionId}): ${message}`);
        }
      });

      ffmpegProcess.on('error', (error) => {
        this.platform.log.error(`Camera ffmpeg error (${sessionId}): ${error.message}`);
      });

      ffmpegProcess.on('close', (code, signal) => {
        const expectedStop = this.stoppingSessions.has(sessionId)
          || signal === 'SIGTERM'
          || signal === 'SIGKILL';

        if (code && code !== 0 && !expectedStop) {
          const details = stderrBuffer.trim();
          if (details.length > 0) {
            this.platform.log.error(`Camera ffmpeg failed (${sessionId}) code=${code}: ${details}`);
          } else {
            this.platform.log.error(`Camera ffmpeg failed (${sessionId}) code=${code}`);
          }
        }

        this.platform.log.info(`Camera stream stopped (${sessionId}) code=${code} signal=${signal ?? 'none'}`);
        this.stoppingSessions.delete(sessionId);
        this.ongoingSessions.delete(sessionId);
      });

      callback();
      return;
    }
    case this.platform.api.hap.StreamRequestTypes.RECONFIGURE:
      callback();
      return;
    case this.platform.api.hap.StreamRequestTypes.STOP:
      this.stopSession(sessionId);
      this.pendingSessions.delete(sessionId);
      this.closeReturnSocket(sessionId);
      callback();
      return;
    default:
      callback(new Error(`Unhandled stream request type: ${(request as { type?: string }).type ?? 'unknown'}`));
      return;
    }
  }

  updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    this.platform.log.info(`HKSV recording active: ${active}`);
    this.updateUnifiedPipelineState();
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    const hadConfig = this.recordingConfig != null;
    this.recordingConfig = configuration;

    if (!configuration) {
      this.platform.log.warn('HKSV recording configuration cleared.');
      this.updateUnifiedPipelineState();
      return;
    }

    const [width, height, fps] = configuration.videoCodec.resolution;
    this.platform.log.info(
      `HKSV recording config: ${width}x${height}@${fps}`
      + ` bitrate=${configuration.videoCodec.parameters.bitRate}kbps`
      + ` fragment=${configuration.mediaContainerConfiguration.fragmentLength}ms`,
    );

    if (hadConfig && this.unifiedStdoutIsHksv && this.unifiedProcess) {
      this.platform.log.info('HKSV config changed — restarting unified pipeline.');
      this.stopUnifiedPipeline();
    }

    this.updateUnifiedPipelineState();
  }

  async *handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
    if (!this.recordingActive) {
      throw new Error('HKSV recording requested while recording is inactive.');
    }

    const recordingConfig = this.recordingConfig;
    if (!recordingConfig) {
      throw new Error('HKSV recording requested without a recording configuration.');
    }

    this.updateUnifiedPipelineState();
    await this.waitForRecordingInit(12000);

    const initSegment = this.recordingInitSegment;
    if (!initSegment) {
      throw new Error('HKSV init segment unavailable.');
    }

    const consumer: RecordingConsumer = {
      streamId,
      queue: [],
      waiters: [],
      closed: false,
      endAfterNextFragment: false,
    };

    consumer.queue.push({ data: initSegment, isLast: false });

    const cutoff = Date.now() - this.getCurrentPrebufferLengthMs();
    for (const fragment of this.prebufferFragments) {
      if (fragment.timestamp >= cutoff) {
        consumer.queue.push({ data: fragment.data, isLast: false });
      }
    }

    this.recordingConsumers.set(streamId, consumer);
    this.platform.log.info(`HKSV stream opened (${streamId}) with ${Math.max(0, consumer.queue.length - 1)} prebuffer fragments.`);

    try {
      while (!consumer.closed) {
        if (consumer.queue.length > 0) {
          const packet = consumer.queue.shift();
          if (!packet) {
            continue;
          }

          yield packet;

          if (packet.isLast) {
            break;
          }

          continue;
        }

        await new Promise<void>((resolve) => consumer.waiters.push(resolve));
      }
    } finally {
      consumer.closed = true;
      this.recordingConsumers.delete(streamId);
      this.wakeConsumer(consumer);
      this.platform.log.debug(`HKSV stream cleanup complete (${streamId}).`);
    }
  }

  acknowledgeStream(streamId: number): void {
    this.platform.log.debug(`HKSV stream acknowledged: ${streamId}`);
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    const consumer = this.recordingConsumers.get(streamId);
    if (!consumer) {
      return;
    }

    if (consumer.queue.length > 0) {
      const last = consumer.queue.pop();
      if (last) {
        consumer.queue.push({ data: last.data, isLast: true });
      }
    }

    consumer.closed = true;
    this.wakeConsumer(consumer);
    this.recordingConsumers.delete(streamId);
    this.platform.log.debug(`HKSV close stream ${streamId}, reason=${reason ?? 'unknown'}`);
  }

  private updateUnifiedPipelineState(): void {
    const hasHksv = this.platform.isHksvEnabled(this.context.printerId) && !!this.recordingActive && this.recordingConfig != null;
    const hasMotion = this.platform.isLocalMotionDetectionEnabled(this.context.printerId);

    if (!hasHksv && !hasMotion) {
      this.stopUnifiedPipeline();
      return;
    }

    if (this.unifiedProcess) {
      const matchesHksv = this.unifiedStdoutIsHksv === hasHksv;
      const matchesMotion = this.unifiedHasPipe3Motion === (hasHksv && hasMotion);
      if (matchesHksv && matchesMotion) {
        return;
      }

      this.stopUnifiedPipeline();
    }

    this.startUnifiedPipeline(hasHksv, hasMotion);
  }

  private startUnifiedPipeline(hasHksv: boolean, hasMotion: boolean): void {
    if (this.unifiedProcess || this.unifiedRestartTimer) {
      return;
    }

    const streamUrl = this.platform.getCameraStreamUrl(this.context.printerId);
    if (!streamUrl) {
      this.platform.log.warn('Cannot start unified pipeline: camera stream URL not configured.');
      return;
    }

    const codec = this.platform.getCameraVideoCodec(this.context.printerId);
    const ffmpegPath = this.platform.getFfmpegPath(this.context.printerId);
    const relayCodecArgs = codec === 'libx264'
      ? ['-preset', 'ultrafast', '-tune', 'zerolatency', '-x264-params', 'aud=1:repeat-headers=1']
      : ['-realtime', '1'];

    let filterComplex: string;
    const outputArgs: string[] = [];
    const needsPipe3 = hasHksv && hasMotion;

    if (hasHksv && hasMotion && this.recordingConfig) {
      const cfg = this.recordingConfig;
      const [w, h, fps] = cfg.videoCodec.resolution;
      const bitrate = Math.max(256, cfg.videoCodec.parameters.bitRate);
      const frag = cfg.mediaContainerConfiguration.fragmentLength;
      const iFrameMs = Math.max(1000, cfg.videoCodec.parameters.iFrameInterval);
      const prof = this.toH264ProfileString(cfg.videoCodec.parameters.profile) ?? 'high';
      const lvl = this.toH264LevelString(cfg.videoCodec.parameters.level) ?? '4.0';
      const gop = Math.max(12, Math.round((fps * iFrameMs) / 1000));
      const gopMin = Math.max(12, Math.floor(gop / 2));
      const hksvCodecArgs = codec === 'libx264'
        ? ['-preset', 'veryfast', '-tune', 'zerolatency']
        : ['-realtime', '1'];

      filterComplex = [
        '[0:v]split=4[vhr][vmr][vrr][vsr]',
        `[vhr]scale=${w}:${h},format=yuv420p[vh]`,
        '[vmr]fps=2,scale=64:36,format=gray[vm]',
        '[vrr]format=yuv420p[vr]',
        `[vsr]fps=${SNAPSHOT_INTERVAL_FPS},scale=1280:720,format=yuv420p[vs]`,
      ].join(';');

      outputArgs.push(
        '-map', '[vh]',
        '-codec:v', codec, ...hksvCodecArgs,
        '-profile:v', prof, '-level:v', lvl,
        '-pix_fmt', 'yuv420p',
        '-r', `${fps}`,
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
        '-g', `${gop}`, '-keyint_min', `${gopMin}`,
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', `${frag * 1000}`,
        '-reset_timestamps', '1',
        '-f', 'mp4', 'pipe:1',
        '-map', '[vm]',
        '-f', 'rawvideo', 'pipe:3',
        '-map', '[vr]',
        '-codec:v', codec, ...relayCodecArgs,
        '-profile:v', 'baseline', '-level:v', '4.0',
        '-pix_fmt', 'yuv420p',
        '-r', `${RELAY_FPS}`,
        '-b:v', `${RELAY_BITRATE_KBPS}k`,
        '-g', `${RELAY_GOP}`, '-keyint_min', `${RELAY_GOP}`,
        '-f', 'mpegts', `udp://127.0.0.1:${this.relayPort}`,
        '-map', '[vs]',
        '-vcodec', 'mjpeg',
        '-f', 'image2', '-update', '1',
        this.snapshotTmpPath,
      );
    } else if (hasHksv && this.recordingConfig) {
      const cfg = this.recordingConfig;
      const [w, h, fps] = cfg.videoCodec.resolution;
      const bitrate = Math.max(256, cfg.videoCodec.parameters.bitRate);
      const frag = cfg.mediaContainerConfiguration.fragmentLength;
      const iFrameMs = Math.max(1000, cfg.videoCodec.parameters.iFrameInterval);
      const prof = this.toH264ProfileString(cfg.videoCodec.parameters.profile) ?? 'high';
      const lvl = this.toH264LevelString(cfg.videoCodec.parameters.level) ?? '4.0';
      const gop = Math.max(12, Math.round((fps * iFrameMs) / 1000));
      const gopMin = Math.max(12, Math.floor(gop / 2));
      const hksvCodecArgs = codec === 'libx264'
        ? ['-preset', 'veryfast', '-tune', 'zerolatency']
        : ['-realtime', '1'];

      filterComplex = [
        '[0:v]split=3[vhr][vrr][vsr]',
        `[vhr]scale=${w}:${h},format=yuv420p[vh]`,
        '[vrr]format=yuv420p[vr]',
        `[vsr]fps=${SNAPSHOT_INTERVAL_FPS},scale=1280:720,format=yuv420p[vs]`,
      ].join(';');

      outputArgs.push(
        '-map', '[vh]',
        '-codec:v', codec, ...hksvCodecArgs,
        '-profile:v', prof, '-level:v', lvl,
        '-pix_fmt', 'yuv420p',
        '-r', `${fps}`,
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
        '-g', `${gop}`, '-keyint_min', `${gopMin}`,
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', `${frag * 1000}`,
        '-reset_timestamps', '1',
        '-f', 'mp4', 'pipe:1',
        '-map', '[vr]',
        '-codec:v', codec, ...relayCodecArgs,
        '-profile:v', 'baseline', '-level:v', '4.0',
        '-pix_fmt', 'yuv420p',
        '-r', `${RELAY_FPS}`,
        '-b:v', `${RELAY_BITRATE_KBPS}k`,
        '-g', `${RELAY_GOP}`, '-keyint_min', `${RELAY_GOP}`,
        '-f', 'mpegts', `udp://127.0.0.1:${this.relayPort}`,
        '-map', '[vs]',
        '-vcodec', 'mjpeg',
        '-f', 'image2', '-update', '1',
        this.snapshotTmpPath,
      );
    } else {
      filterComplex = [
        '[0:v]split=3[vmr][vrr][vsr]',
        '[vmr]fps=2,scale=64:36,format=gray[vm]',
        '[vrr]format=yuv420p[vr]',
        `[vsr]fps=${SNAPSHOT_INTERVAL_FPS},scale=1280:720,format=yuv420p[vs]`,
      ].join(';');

      outputArgs.push(
        '-map', '[vm]',
        '-f', 'rawvideo', 'pipe:1',
        '-map', '[vr]',
        '-codec:v', codec, ...relayCodecArgs,
        '-profile:v', 'baseline', '-level:v', '4.0',
        '-pix_fmt', 'yuv420p',
        '-r', `${RELAY_FPS}`,
        '-b:v', `${RELAY_BITRATE_KBPS}k`,
        '-g', `${RELAY_GOP}`, '-keyint_min', `${RELAY_GOP}`,
        '-f', 'mpegts', `udp://127.0.0.1:${this.relayPort}`,
        '-map', '[vs]',
        '-vcodec', 'mjpeg',
        '-f', 'image2', '-update', '1',
        this.snapshotTmpPath,
      );
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-nostdin',
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', streamUrl,
      '-an',
      '-sn',
      '-filter_complex', filterComplex,
      ...outputArgs,
    ];

    this.platform.log.info(`Unified pipeline ffmpeg args: ${args.join(' ')}`);

    const stdioConfig: Array<'ignore' | 'pipe'> = needsPipe3
      ? ['ignore', 'pipe', 'pipe', 'pipe']
      : ['ignore', 'pipe', 'pipe'];

    this.resetRecordingState();

    const processRef: ChildProcess = spawn(ffmpegPath, args, {
      env: process.env,
      stdio: stdioConfig as unknown as [
        'ignore',
        'pipe',
        'pipe',
        ...Array<'pipe'>,
      ],
    });
    this.unifiedProcess = processRef;
    this.unifiedStdoutIsHksv = hasHksv;
    this.unifiedHasPipe3Motion = needsPipe3;

    let stderrBuffer = '';

    if (hasHksv) {
      processRef.stdout!.on('data', (chunk: Buffer) => {
        this.recordingParserBuffer = Buffer.concat([this.recordingParserBuffer, chunk]);
        this.consumeRecordingParserBuffer();
      });
    } else {
      processRef.stdout!.on('data', (chunk: Buffer) => {
        this.consumeMotionData(chunk);
      });
    }

    if (needsPipe3) {
      const pipe3 = processRef.stdio[3] as NodeJS.ReadableStream;
      pipe3.on('data', (chunk: Buffer) => {
        this.consumeMotionData(chunk);
      });
    }

    processRef.stderr!.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message.length === 0) {
        return;
      }

      stderrBuffer = (stderrBuffer + '\n' + message).slice(-4000);
      this.platform.log.debug(`Unified pipeline: ${message}`);
    });

    processRef.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const expectedStop = signal === 'SIGTERM' || signal === 'SIGKILL';

      if (this.recordingCurrentFragment.length > 0) {
        this.broadcastRecordingFragment(this.recordingCurrentFragment);
        this.recordingCurrentFragment = Buffer.alloc(0);
      }

      if (code && code !== 0 && !expectedStop) {
        const details = stderrBuffer.trim();
        if (details.length > 0) {
          this.platform.log.error(`Unified pipeline failed code=${code}: ${details}`);
        } else {
          this.platform.log.error(`Unified pipeline failed code=${code}`);
        }
      }

      this.unifiedProcess = undefined;
      this.platform.log.info(`Unified pipeline stopped code=${code} signal=${signal ?? 'none'}`);

      if (!expectedStop && (hasHksv || hasMotion)) {
        this.unifiedRestartTimer = setTimeout(() => {
          this.unifiedRestartTimer = undefined;
          this.updateUnifiedPipelineState();
        }, 3000);
      }
    });

    processRef.on('error', (error: Error) => {
      this.platform.log.error(`Unified pipeline spawn error: ${error.message}`);
    });
  }

  private stopUnifiedPipeline(): void {
    if (this.unifiedRestartTimer) {
      clearTimeout(this.unifiedRestartTimer);
      this.unifiedRestartTimer = undefined;
    }

    if (this.unifiedProcess) {
      this.unifiedProcess.kill('SIGTERM');
      this.unifiedProcess = undefined;
    }

    for (const consumer of this.recordingConsumers.values()) {
      if (consumer.queue.length > 0) {
        const tail = consumer.queue.pop();
        if (tail) {
          consumer.queue.push({ data: tail.data, isLast: true });
        }
      }

      consumer.closed = true;
      this.wakeConsumer(consumer);
    }

    this.recordingConsumers.clear();
    this.prebufferFragments.length = 0;
    this.resetRecordingState();
  }

  private resetRecordingState(): void {
    this.recordingParserBuffer = Buffer.alloc(0);
    this.recordingInitAccumulation = Buffer.alloc(0);
    this.recordingCurrentFragment = Buffer.alloc(0);
    this.recordingInitSegment = undefined;
    this.motionFrameBuffer = Buffer.alloc(0);
    this.previousMotionFrame = undefined;
  }

  private startRecordingMonitor(): void {
    if (this.recordingMonitorTimer) {
      return;
    }

    this.recordingMonitorTimer = setInterval(() => {
      this.reconcileRecordingEventBoundaries();
    }, 1000);
  }

  private reconcileRecordingEventBoundaries(): void {
    if (!this.platform.isHksvEnabled(this.context.printerId)) {
      return;
    }

    const eventActive = this.isRecordingEventActive();
    const now = Date.now();
    const postEventTailMs = 4000;

    for (const consumer of this.recordingConsumers.values()) {
      if (consumer.closed) {
        continue;
      }

      if (eventActive) {
        consumer.endRequestedAt = undefined;
        consumer.endAfterNextFragment = false;
        continue;
      }

      if (!consumer.endRequestedAt) {
        consumer.endRequestedAt = now;
      }

      if (now - consumer.endRequestedAt >= postEventTailMs) {
        consumer.endAfterNextFragment = true;
      }
    }
  }

  private isRecordingEventActive(): boolean {
    return this.motionDetected || Date.now() <= this.motionTriggerUntil;
  }

  private consumeRecordingParserBuffer(): void {
    while (true) {
      const boxInfo = this.readNextMp4Box(this.recordingParserBuffer);
      if (!boxInfo) {
        break;
      }

      const { box, boxType, bytesConsumed } = boxInfo;
      this.recordingParserBuffer = this.recordingParserBuffer.subarray(bytesConsumed);

      if (!this.recordingInitSegment) {
        this.recordingInitAccumulation = Buffer.concat([this.recordingInitAccumulation, box]);
        if (boxType === 'moov') {
          this.recordingInitSegment = Buffer.from(this.recordingInitAccumulation);
          this.platform.log.info('HKSV init segment ready.');
          this.recordingInitAccumulation = Buffer.alloc(0);
        }

        continue;
      }

      if (boxType === 'moof') {
        if (this.recordingCurrentFragment.length > 0) {
          this.broadcastRecordingFragment(this.recordingCurrentFragment);
        }

        this.recordingCurrentFragment = Buffer.from(box);
        continue;
      }

      if (boxType === 'mdat') {
        this.recordingCurrentFragment = Buffer.concat([this.recordingCurrentFragment, box]);
        this.broadcastRecordingFragment(this.recordingCurrentFragment);
        this.recordingCurrentFragment = Buffer.alloc(0);
        continue;
      }

      if (this.recordingCurrentFragment.length > 0) {
        this.recordingCurrentFragment = Buffer.concat([this.recordingCurrentFragment, box]);
      }
    }
  }

  private broadcastRecordingFragment(fragment: Buffer): void {
    if (fragment.length === 0) {
      return;
    }

    const now = Date.now();
    this.prebufferFragments.push({ timestamp: now, data: Buffer.from(fragment) });

    const prebufferCutoff = now - this.getCurrentPrebufferLengthMs();
    while (this.prebufferFragments.length > 0 && this.prebufferFragments[0].timestamp < prebufferCutoff) {
      this.prebufferFragments.shift();
    }

    for (const consumer of this.recordingConsumers.values()) {
      if (consumer.closed) {
        continue;
      }

      const isLast = consumer.endAfterNextFragment;
      consumer.queue.push({ data: Buffer.from(fragment), isLast });
      if (isLast) {
        consumer.closed = true;
      }

      this.wakeConsumer(consumer);
    }
  }

  private wakeConsumer(consumer: RecordingConsumer): void {
    while (consumer.waiters.length > 0) {
      consumer.waiters.shift()?.();
    }
  }

  private async waitForRecordingInit(timeoutMs: number): Promise<void> {
    const start = Date.now();

    while (!this.recordingInitSegment) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for HKSV init segment.');
      }

      if (!this.unifiedProcess) {
        this.updateUnifiedPipelineState();
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private getCurrentPrebufferLengthMs(): number {
    if (!this.recordingConfig) {
      return this.platform.getHksvPrebufferLengthMs(this.context.printerId);
    }

    return Math.max(4000, this.recordingConfig.prebufferLength);
  }

  private consumeMotionData(chunk: Buffer): void {
    this.motionFrameBuffer = Buffer.concat([this.motionFrameBuffer, chunk]);

    while (this.motionFrameBuffer.length >= MOTION_FRAME_BYTES) {
      const frame = this.motionFrameBuffer.subarray(0, MOTION_FRAME_BYTES);
      this.motionFrameBuffer = this.motionFrameBuffer.subarray(MOTION_FRAME_BYTES);
      this.handleMotionFrame(frame);
    }
  }

  private handleMotionFrame(frame: Buffer): void {
    if (!this.previousMotionFrame) {
      this.previousMotionFrame = Buffer.from(frame);
      return;
    }

    let diffTotal = 0;
    for (let index = 0; index < frame.length; index++) {
      diffTotal += Math.abs(frame[index] - this.previousMotionFrame[index]);
    }

    this.previousMotionFrame = Buffer.from(frame);

    const diffRatio = diffTotal / (frame.length * 255);
    const threshold = this.sensitivityToThreshold(this.platform.getMotionSensitivity(this.context.printerId));

    if (diffRatio >= threshold) {
      this.motionTriggerUntil = Date.now() + this.platform.getHksvMaxRecordingSeconds(this.context.printerId) * 1000;
      this.updateMotionDetected(true);
      return;
    }

    if (Date.now() > this.motionTriggerUntil) {
      this.updateMotionDetected(false);
    }
  }

  private updateMotionDetected(detected: boolean): void {
    const motionService = this.controller.motionService;
    if (!motionService) {
      return;
    }

    if (detected) {
      if (this.motionResetTimer) {
        clearTimeout(this.motionResetTimer);
      }

      this.motionDetected = true;
      motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);

      this.motionResetTimer = setTimeout(() => {
        this.motionDetected = false;
        motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
      }, 15000);
      return;
    }

    if (!this.motionDetected) {
      return;
    }

    this.motionDetected = false;
    motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
  }

  private sensitivityToThreshold(sensitivity: number): number {
    const normalized = (Math.max(1, Math.min(100, sensitivity)) - 1) / 99;
    return 0.2 - normalized * 0.19;
  }

  private async prepareStreamInternal(
    request: PrepareStreamRequest,
    callback: (error?: Error, response?: PrepareStreamResponse) => void,
  ): Promise<void> {
    let callbackSent = false;
    const safeCallback = (error?: Error, response?: PrepareStreamResponse) => {
      if (callbackSent) {
        return;
      }

      callbackSent = true;
      callback(error, response);
    };

    try {
      const { port: videoPort, socket: returnSocket } = await this.bindReturnPort();
      const videoSSRC = this.randomSsrc();

      this.platform.log.info(
        `Preparing stream ${request.sessionID}`
        + ` source=${request.sourceAddress}`
        + ` version=${request.addressVersion}`
        + ` target=${request.targetAddress}:${request.video.port}`
        + ` returnPort=${videoPort}`,
      );

      const sessionInfo: CameraSessionInfo = {
        videoSSRC,
        videoCryptoSuite: request.video.srtpCryptoSuite,
        targetAddress: request.targetAddress,
        targetVideoPort: request.video.port,
        videoKey: request.video.srtp_key,
        videoSalt: request.video.srtp_salt,
      };

      this.pendingSessions.set(request.sessionID, sessionInfo);
      this.returnSockets.set(request.sessionID, returnSocket);

      const response: PrepareStreamResponse = {
        video: {
          port: videoPort,
          ssrc: videoSSRC,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      };

      safeCallback(undefined, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      safeCallback(new Error(`Failed to prepare camera stream: ${message}`));
    }
  }

  private randomSsrc(): number {
    return Math.floor(Math.random() * 0x7fffffff) + 1;
  }

  private async bindReturnPort(): Promise<{ port: number; socket: Socket }> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');

      socket.once('error', (error) => {
        socket.close();
        reject(error);
      });

      socket.bind(0, () => {
        const address = socket.address();
        if (typeof address === 'string') {
          socket.close();
          reject(new Error('Unexpected string socket address.'));
          return;
        }

        resolve({ port: address.port, socket });
      });
    });
  }

  private stopOtherSessions(currentSessionId: string): void {
    for (const sessionId of this.ongoingSessions.keys()) {
      if (sessionId !== currentSessionId) {
        this.stopSession(sessionId);
      }
    }

    for (const sessionId of this.pendingSessions.keys()) {
      if (sessionId !== currentSessionId) {
        this.pendingSessions.delete(sessionId);
        this.closeReturnSocket(sessionId);
      }
    }
  }

  private stopSession(sessionId: string): void {
    const ffmpegProcess = this.ongoingSessions.get(sessionId);
    if (!ffmpegProcess) {
      return;
    }

    this.stoppingSessions.add(sessionId);
    ffmpegProcess.kill('SIGTERM');
    this.ongoingSessions.delete(sessionId);
    this.closeReturnSocket(sessionId);
  }

  private closeReturnSocket(sessionId: string): void {
    const socket = this.returnSockets.get(sessionId);
    if (!socket) {
      return;
    }

    try {
      socket.close();
    } catch {
      // already closed
    }

    this.returnSockets.delete(sessionId);
  }

  private toSrtpSuiteString(suite: number): string | undefined {
    if (suite === this.platform.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80) {
      return 'AES_CM_128_HMAC_SHA1_80';
    }

    return undefined;
  }

  private toH264ProfileString(profile: number): string | undefined {
    if (profile === this.platform.api.hap.H264Profile.BASELINE) {
      return 'baseline';
    }

    if (profile === this.platform.api.hap.H264Profile.MAIN) {
      return 'main';
    }

    if (profile === this.platform.api.hap.H264Profile.HIGH) {
      return 'high';
    }

    return undefined;
  }

  private toH264LevelString(level: number): string | undefined {
    if (level === this.platform.api.hap.H264Level.LEVEL3_1) {
      return '3.1';
    }

    if (level === this.platform.api.hap.H264Level.LEVEL3_2) {
      return '3.2';
    }

    if (level === this.platform.api.hap.H264Level.LEVEL4_0) {
      return '4.0';
    }

    return undefined;
  }

  private sanitizePacketSize(mtu: number): number {
    if (!Number.isFinite(mtu) || mtu <= 0) {
      return 1316;
    }

    return Math.max(400, Math.min(1316, Math.floor(mtu)));
  }

  private formatTargetHost(address: string): string {
    if (address.includes(':') && !address.startsWith('[')) {
      return `[${address}]`;
    }

    return address;
  }

  private readNextMp4Box(buffer: Buffer): Mp4BoxInfo | undefined {
    if (buffer.length < 8) {
      return undefined;
    }

    const boxSize32 = buffer.readUInt32BE(0);
    const boxType = buffer.subarray(4, 8).toString('ascii');

    if (boxSize32 === 0) {
      return undefined;
    }

    if (boxSize32 === 1) {
      if (buffer.length < 16) {
        return undefined;
      }

      const boxSize64 = Number(buffer.readBigUInt64BE(8));
      if (!Number.isFinite(boxSize64) || boxSize64 <= 16 || buffer.length < boxSize64) {
        return undefined;
      }

      return { box: buffer.subarray(0, boxSize64), boxType, bytesConsumed: boxSize64 };
    }

    if (boxSize32 < 8 || buffer.length < boxSize32) {
      return undefined;
    }

    return { box: buffer.subarray(0, boxSize32), boxType, bytesConsumed: boxSize32 };
  }
}

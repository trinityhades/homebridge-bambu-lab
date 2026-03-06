import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';

import { BambuCameraAccessory } from './cameraAccessory.js';
import { BambuPrinterAccessory, type AccessoryKind } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface BambuPrinterConfig {
  name?: string;
  model?: string;
  ipAddress?: string;
  serialNumber?: string;
  lanAccessCode?: string;
  mqttPort?: number;
  mqttUsername?: string;
  rejectUnauthorized?: boolean;
  enableSpeedControl?: boolean;
  enableCamera?: boolean;
  cameraRtspUrl?: string;
  cameraName?: string;
  ffmpegPath?: string;
  cameraVideoCodec?: 'libx264' | 'h264_videotoolbox';
  enableHksv?: boolean;
  enableLocalMotionDetection?: boolean;
  motionSensitivity?: number;
  hksvPrebufferLengthMs?: number;
  hksvFragmentLengthMs?: number;
  hksvMaxRecordingSeconds?: number;
}

interface BambuPlatformConfig extends PlatformConfig, BambuPrinterConfig {
  printers?: BambuPrinterConfig[];
}

export interface PrinterState {
  online: boolean;
  printing: boolean;
  paused: boolean;
  chamberLightOn: boolean;
  speedPercent: number;
}

export interface AccessoryDeviceContext {
  printerId: string;
  serialNumber: string;
  model: string;
  uniqueId: string;
  displayName: string;
  kind: AccessoryKind;
}

interface ManagedPrinter {
  config: Required<Pick<BambuPrinterConfig, 'name' | 'model' | 'ipAddress' | 'serialNumber' | 'lanAccessCode'>> & BambuPrinterConfig;
  state: PrinterState;
  mqttClient?: MqttClient;
  requestTopic: string;
  reportTopic: string;
}

const DEFAULT_PRINTER_NAME = 'Bambu Printer';
const DEFAULT_PRINTER_MODEL = 'Bambu Printer';
const DEFAULT_MQTT_PORT = 8883;
const DEFAULT_MQTT_USERNAME = 'bblp';

function createDefaultState(): PrinterState {
  return {
    online: false,
    printing: false,
    paused: false,
    chamberLightOn: false,
    speedPercent: 50,
  };
}

export class BambuPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  private readonly accessoryHandlers: Map<string, BambuPrinterAccessory> = new Map();
  private readonly configTyped: BambuPlatformConfig;
  private readonly printers: Map<string, ManagedPrinter> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.configTyped = config as BambuPlatformConfig;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.initializePrinters();
      this.discoverDevices();
      this.connectMqttClients();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  registerAccessoryHandler(accessoryUUID: string, handler: BambuPrinterAccessory) {
    this.accessoryHandlers.set(accessoryUUID, handler);
  }

  unregisterAccessoryHandler(accessoryUUID: string) {
    this.accessoryHandlers.delete(accessoryUUID);
  }

  getState(printerId: string): PrinterState {
    return { ...(this.printers.get(printerId)?.state ?? createDefaultState()) };
  }

  getPrinterModel(printerId: string): string {
    return this.printers.get(printerId)?.config.model ?? DEFAULT_PRINTER_MODEL;
  }

  getPrinterSerialNumber(printerId: string): string {
    return this.printers.get(printerId)?.config.serialNumber ?? 'Unknown';
  }

  getCameraStreamUrl(printerId: string): string | undefined {
    const printer = this.printers.get(printerId);
    if (!printer) {
      return undefined;
    }

    if (printer.config.cameraRtspUrl) {
      return printer.config.cameraRtspUrl;
    }

    return `rtsps://${printer.config.mqttUsername ?? DEFAULT_MQTT_USERNAME}:${printer.config.lanAccessCode}@${printer.config.ipAddress}:322/streaming/live/1`;
  }

  getFfmpegPath(printerId: string): string {
    return this.printers.get(printerId)?.config.ffmpegPath ?? 'ffmpeg';
  }

  getCameraVideoCodec(printerId: string): 'libx264' | 'h264_videotoolbox' {
    const configured = this.printers.get(printerId)?.config.cameraVideoCodec;
    if (configured === 'libx264' || configured === 'h264_videotoolbox') {
      return configured;
    }

    return process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264';
  }

  isHksvEnabled(printerId: string): boolean {
    return this.printers.get(printerId)?.config.enableHksv === true;
  }

  isLocalMotionDetectionEnabled(printerId: string): boolean {
    const configured = this.printers.get(printerId)?.config.enableLocalMotionDetection;
    if (configured !== undefined) {
      return configured;
    }

    return this.isHksvEnabled(printerId);
  }

  shouldExposeMotionSensor(printerId: string): boolean {
    return this.isHksvEnabled(printerId) || this.isLocalMotionDetectionEnabled(printerId);
  }

  getMotionSensitivity(printerId: string): number {
    const configured = this.printers.get(printerId)?.config.motionSensitivity;
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return 40;
    }

    return Math.max(1, Math.min(100, Math.round(configured)));
  }

  getHksvPrebufferLengthMs(printerId: string): number {
    const configured = this.printers.get(printerId)?.config.hksvPrebufferLengthMs;
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return 4000;
    }

    return Math.max(4000, Math.min(8000, Math.round(configured)));
  }

  getHksvFragmentLengthMs(printerId: string): number {
    const configured = this.printers.get(printerId)?.config.hksvFragmentLengthMs;
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return 4000;
    }

    return Math.max(2000, Math.min(8000, Math.round(configured)));
  }

  getHksvMaxRecordingSeconds(printerId: string): number {
    const configured = this.printers.get(printerId)?.config.hksvMaxRecordingSeconds;
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return 20;
    }

    return Math.max(5, Math.min(120, Math.round(configured)));
  }

  async setChamberLight(printerId: string, on: boolean): Promise<void> {
    const printer = this.getRequiredPrinter(printerId);
    printer.state.chamberLightOn = on;

    await this.publishCommand(printerId, {
      system: {
        sequence_id: '0',
        command: 'ledctrl',
        led_node: 'chamber_light',
        led_mode: on ? 'on' : 'off',
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 0,
        interval_time: 0,
      },
    });
  }

  async setPrintingActive(printerId: string, active: boolean): Promise<void> {
    await this.publishCommand(printerId, {
      print: {
        sequence_id: '0',
        command: active ? 'resume' : 'pause',
      },
    });
  }

  async setSpeedPercent(printerId: string, percent: number): Promise<void> {
    const printer = this.getRequiredPrinter(printerId);
    const normalized = Math.max(0, Math.min(100, Math.round(percent)));
    const speedProfile = this.speedPercentToProfile(normalized);

    printer.state.speedPercent = normalized;
    await this.publishCommand(printerId, {
      print: {
        sequence_id: '0',
        command: 'print_speed',
        param: speedProfile,
      },
    });
  }

  discoverDevices() {
    const discoveredCacheUUIDs: string[] = [];

    for (const printer of this.printers.values()) {
      const printerId = printer.config.serialNumber;
      const baseName = printer.config.name;
      const devices: AccessoryDeviceContext[] = [
        {
          printerId,
          serialNumber: printer.config.serialNumber,
          model: printer.config.model,
          uniqueId: `${printer.config.serialNumber}-light`,
          displayName: `${baseName} Chamber Light`,
          kind: 'light',
        },
        {
          printerId,
          serialNumber: printer.config.serialNumber,
          model: printer.config.model,
          uniqueId: `${printer.config.serialNumber}-print-control`,
          displayName: `${baseName} Print`,
          kind: 'printControl',
        },
      ];

      if (printer.config.enableSpeedControl) {
        devices.push({
          printerId,
          serialNumber: printer.config.serialNumber,
          model: printer.config.model,
          uniqueId: `${printer.config.serialNumber}-speed`,
          displayName: `${baseName} Print Speed`,
          kind: 'speedControl',
        });
      }

      if (printer.config.enableCamera !== false) {
        devices.push({
          printerId,
          serialNumber: printer.config.serialNumber,
          model: printer.config.model,
          uniqueId: `${printer.config.serialNumber}-camera`,
          displayName: printer.config.cameraName ?? `${baseName} Camera`,
          kind: 'camera',
        });
      }

      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(device.uniqueId);
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          existingAccessory.context.device = device;
          existingAccessory.displayName = device.displayName;

          if (device.kind === 'camera') {
            existingAccessory.category = this.api.hap.Categories.IP_CAMERA;
          }

          this.api.updatePlatformAccessories([existingAccessory]);
          this.accessories.set(uuid, existingAccessory);

          if (device.kind === 'camera') {
            new BambuCameraAccessory(this, existingAccessory);
          } else {
            new BambuPrinterAccessory(this, existingAccessory);
          }
        } else {
          this.log.info('Adding new accessory:', device.displayName);

          const category = device.kind === 'camera' ? this.api.hap.Categories.IP_CAMERA : undefined;
          const accessory = new this.api.platformAccessory(device.displayName, uuid, category);
          accessory.context.device = device;

          if (device.kind === 'camera') {
            new BambuCameraAccessory(this, accessory);
          } else {
            new BambuPrinterAccessory(this, accessory);
          }

          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.set(uuid, accessory);
        }

        discoveredCacheUUIDs.push(uuid);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.unregisterAccessoryHandler(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  private initializePrinters() {
    this.printers.clear();

    const printers = this.getNormalizedPrinters();
    if (printers.length === 0) {
      this.log.warn('No Bambu printers configured. Add at least one printer in the Homebridge settings UI.');
      return;
    }

    for (const printer of printers) {
      this.printers.set(printer.serialNumber, {
        config: printer,
        state: createDefaultState(),
        requestTopic: `device/${printer.serialNumber}/request`,
        reportTopic: `device/${printer.serialNumber}/report`,
      });
    }
  }

  private connectMqttClients() {
    for (const printerId of this.printers.keys()) {
      this.connectMqtt(printerId);
    }
  }

  private connectMqtt(printerId: string) {
    const printer = this.getRequiredPrinter(printerId);

    const url = `mqtts://${printer.config.ipAddress}:${printer.config.mqttPort ?? DEFAULT_MQTT_PORT}`;
    const options: IClientOptions = {
      username: printer.config.mqttUsername ?? DEFAULT_MQTT_USERNAME,
      password: printer.config.lanAccessCode,
      reconnectPeriod: 5000,
      keepalive: 30,
      rejectUnauthorized: printer.config.rejectUnauthorized ?? false,
      clientId: `homebridge-bambu-lab-${printer.config.serialNumber.slice(-6)}-${Math.floor(Math.random() * 10000)}`,
    };

    this.log.info(`Connecting to ${printer.config.name} MQTT broker at ${url}`);

    printer.mqttClient = mqtt.connect(url, options);

    printer.mqttClient.on('connect', () => {
      this.log.info(`MQTT connected for ${printer.config.name}`);
      printer.state.online = true;
      this.syncAccessories(printerId);

      printer.mqttClient?.subscribe(printer.reportTopic, { qos: 0 }, (err) => {
        if (err) {
          this.log.error(`Failed to subscribe to ${printer.reportTopic}: ${err.message}`);
          return;
        }

        this.log.info(`Subscribed to ${printer.reportTopic}`);

        void this.publishCommand(printerId, {
          pushing: {
            sequence_id: '0',
            command: 'pushall',
          },
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log.error(`Failed to request full state for ${printer.config.name}: ${message}`);
        });
      });
    });

    printer.mqttClient.on('message', (topic, payload) => {
      if (topic !== printer.reportTopic) {
        return;
      }

      this.handleReportMessage(printerId, payload.toString());
    });

    printer.mqttClient.on('reconnect', () => {
      this.log.warn(`MQTT disconnected for ${printer.config.name}, attempting reconnect...`);
      printer.state.online = false;
      this.syncAccessories(printerId);
    });

    printer.mqttClient.on('close', () => {
      this.log.warn(`MQTT connection closed for ${printer.config.name}`);
      printer.state.online = false;
      this.syncAccessories(printerId);
    });

    printer.mqttClient.on('offline', () => {
      this.log.warn(`MQTT client is offline for ${printer.config.name}`);
      printer.state.online = false;
      this.syncAccessories(printerId);
    });

    printer.mqttClient.on('error', (error) => {
      this.log.error(`MQTT error for ${printer.config.name}: ${error.message}`);
    });
  }

  private async publishCommand(printerId: string, payload: Record<string, unknown>): Promise<void> {
    const printer = this.getRequiredPrinter(printerId);
    if (!printer.mqttClient) {
      throw new Error(`MQTT client is not initialized for ${printer.config.name}.`);
    }

    if (!printer.mqttClient.connected) {
      throw new Error(`MQTT client is not connected for ${printer.config.name}.`);
    }

    const body = JSON.stringify(payload);

    await new Promise<void>((resolve, reject) => {
      printer.mqttClient?.publish(printer.requestTopic, body, { qos: 0 }, (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.log.debug(`MQTT publish ${printer.requestTopic}: ${body}`);
  }

  private handleReportMessage(printerId: string, rawPayload: string) {
    const printer = this.getRequiredPrinter(printerId);

    try {
      const parsed = JSON.parse(rawPayload) as {
        print?: {
          gcode_state?: string;
          online?: unknown;
          lights_report?: Array<{ node?: string; mode?: string }>;
          spd_lvl?: number;
        };
      };

      const print = parsed.print;
      if (!print) {
        return;
      }

      if (print.online !== undefined) {
        printer.state.online = true;
      }

      if (typeof print.gcode_state === 'string') {
        const gcodeState = print.gcode_state.toLowerCase();

        const isPaused = gcodeState === 'pause' || gcodeState === 'paused';
        const isIdle = gcodeState === 'idle' || gcodeState === 'finish' || gcodeState === 'failed';

        printer.state.paused = isPaused;
        printer.state.printing = !isIdle;
      }

      if (Array.isArray(print.lights_report)) {
        const chamber = print.lights_report.find((entry) => entry.node === 'chamber_light');
        if (chamber?.mode) {
          printer.state.chamberLightOn = chamber.mode.toLowerCase() === 'on';
        }
      }

      if (typeof print.spd_lvl === 'number') {
        printer.state.speedPercent = this.profileToPercent(print.spd_lvl);
      }

      this.syncAccessories(printerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Unable to parse MQTT payload for ${printer.config.name}: ${message}`);
      this.log.debug(`Raw payload: ${rawPayload}`);
    }
  }

  private speedPercentToProfile(percent: number): string {
    if (percent <= 25) {
      return '1';
    }

    if (percent <= 50) {
      return '2';
    }

    if (percent <= 75) {
      return '3';
    }

    return '4';
  }

  private profileToPercent(profile: number): number {
    switch (profile) {
    case 1:
      return 25;
    case 2:
      return 50;
    case 3:
      return 75;
    case 4:
      return 100;
    default:
      return 50;
    }
  }

  private syncAccessories(printerId: string) {
    for (const handler of this.accessoryHandlers.values()) {
      if (handler.getPrinterId() === printerId) {
        handler.syncState(this.getState(printerId));
      }
    }
  }

  private getRequiredPrinter(printerId: string): ManagedPrinter {
    const printer = this.printers.get(printerId);
    if (!printer) {
      throw new Error(`Unknown printer: ${printerId}`);
    }

    return printer;
  }

  private getNormalizedPrinters(): Array<ManagedPrinter['config']> {
    const configuredPrinters = this.getConfiguredPrinters();
    const normalizedPrinters: Array<ManagedPrinter['config']> = [];
    const seenSerials = new Set<string>();

    configuredPrinters.forEach((printer, index) => {
      const ipAddress = this.normalizeString(printer.ipAddress);
      const serialNumber = this.normalizeString(printer.serialNumber);
      const lanAccessCode = this.normalizeString(printer.lanAccessCode);

      if (!ipAddress || !serialNumber || !lanAccessCode) {
        this.log.warn(`Skipping printer #${index + 1}: ipAddress, serialNumber, and lanAccessCode are required.`);
        return;
      }

      if (seenSerials.has(serialNumber)) {
        this.log.warn(`Skipping duplicate printer serial number: ${serialNumber}`);
        return;
      }

      seenSerials.add(serialNumber);

      const model = this.normalizeString(printer.model) ?? DEFAULT_PRINTER_MODEL;
      const name = this.normalizeString(printer.name) ?? this.buildDefaultPrinterName(model, serialNumber, index);

      normalizedPrinters.push({
        ...printer,
        name,
        model,
        ipAddress,
        serialNumber,
        lanAccessCode,
        mqttUsername: this.normalizeString(printer.mqttUsername) ?? DEFAULT_MQTT_USERNAME,
        mqttPort: typeof printer.mqttPort === 'number' ? printer.mqttPort : DEFAULT_MQTT_PORT,
      });
    });

    return normalizedPrinters;
  }

  private getConfiguredPrinters(): BambuPrinterConfig[] {
    if (Array.isArray(this.configTyped.printers) && this.configTyped.printers.length > 0) {
      return this.configTyped.printers;
    }

    if (this.hasLegacyPrinterConfig()) {
      this.log.info('Using legacy single-printer configuration. Save settings in the Homebridge UI to migrate to the new multi-printer format.');

      return [{
        name: this.normalizeString(this.configTyped.name) ?? DEFAULT_PRINTER_NAME,
        model: DEFAULT_PRINTER_MODEL,
        ipAddress: this.configTyped.ipAddress,
        serialNumber: this.configTyped.serialNumber,
        lanAccessCode: this.configTyped.lanAccessCode,
        mqttPort: this.configTyped.mqttPort,
        mqttUsername: this.configTyped.mqttUsername,
        rejectUnauthorized: this.configTyped.rejectUnauthorized,
        enableSpeedControl: this.configTyped.enableSpeedControl,
        enableCamera: this.configTyped.enableCamera,
        cameraRtspUrl: this.configTyped.cameraRtspUrl,
        cameraName: this.configTyped.cameraName,
        ffmpegPath: this.configTyped.ffmpegPath,
        cameraVideoCodec: this.configTyped.cameraVideoCodec,
        enableHksv: this.configTyped.enableHksv,
        enableLocalMotionDetection: this.configTyped.enableLocalMotionDetection,
        motionSensitivity: this.configTyped.motionSensitivity,
        hksvPrebufferLengthMs: this.configTyped.hksvPrebufferLengthMs,
        hksvFragmentLengthMs: this.configTyped.hksvFragmentLengthMs,
        hksvMaxRecordingSeconds: this.configTyped.hksvMaxRecordingSeconds,
      }];
    }

    return [];
  }

  private hasLegacyPrinterConfig(): boolean {
    return Boolean(
      this.normalizeString(this.configTyped.ipAddress)
      || this.normalizeString(this.configTyped.serialNumber)
      || this.normalizeString(this.configTyped.lanAccessCode),
    );
  }

  private buildDefaultPrinterName(model: string, serialNumber: string, index: number): string {
    const normalizedModel = model === DEFAULT_PRINTER_MODEL ? DEFAULT_PRINTER_NAME : model;
    const suffix = serialNumber.length >= 4 ? serialNumber.slice(-4) : `${index + 1}`;
    return `${normalizedModel} ${suffix}`;
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}

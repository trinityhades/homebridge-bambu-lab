import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { AccessoryDeviceContext, BambuPlatform, PrinterState } from './platform.js';

export type AccessoryKind = 'light' | 'printControl' | 'speedControl' | 'camera';

export class BambuPrinterAccessory {
  private service: Service;
  private readonly context: AccessoryDeviceContext;

  constructor(
    private readonly platform: BambuPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.context = accessory.context.device as AccessoryDeviceContext;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Bambu Lab')
      .setCharacteristic(this.platform.Characteristic.Model, this.platform.getPrinterModel(this.context.printerId))
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.platform.getPrinterSerialNumber(this.context.printerId));

    if (this.context.kind === 'light') {
      this.service = this.accessory.getService(this.platform.Service.Lightbulb)
        || this.accessory.addService(this.platform.Service.Lightbulb);

      this.service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setLightOn.bind(this))
        .onGet(this.getLightOn.bind(this));
    } else if (this.context.kind === 'printControl') {
      this.service = this.accessory.getService(this.platform.Service.Switch)
        || this.accessory.addService(this.platform.Service.Switch);

      this.service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setPrintActive.bind(this))
        .onGet(this.getPrintActive.bind(this));
    } else if (this.context.kind === 'speedControl') {
      this.service = this.accessory.getService(this.platform.Service.Fan)
        || this.accessory.addService(this.platform.Service.Fan);

      this.service.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setSpeedOn.bind(this))
        .onGet(this.getSpeedOn.bind(this));

      this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 5 })
        .onSet(this.setSpeedPercent.bind(this))
        .onGet(this.getSpeedPercent.bind(this));
    } else {
      throw new Error(`Unsupported accessory kind for BambuPrinterAccessory: ${this.context.kind}`);
    }

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.context.displayName);
    this.platform.registerAccessoryHandler(this.accessory.UUID, this);
    this.syncState(this.platform.getState(this.context.printerId));

    this.accessory.on('identify', () => {
      this.platform.log.info(`${this.context.displayName} identified!`);
    });
  }

  syncState(state: PrinterState) {
    if (this.context.kind === 'light') {
      this.service.updateCharacteristic(this.platform.Characteristic.On, state.online ? state.chamberLightOn : false);
      return;
    }

    if (this.context.kind === 'printControl') {
      const isActive = state.online && state.printing && !state.paused;
      this.service.updateCharacteristic(this.platform.Characteristic.On, isActive);
      return;
    }

    if (this.context.kind === 'speedControl') {
      this.service.updateCharacteristic(this.platform.Characteristic.On, state.online);
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, state.speedPercent);
    }
  }

  getPrinterId(): string {
    return this.context.printerId;
  }

  private async setLightOn(value: CharacteristicValue) {
    const on = value as boolean;

    try {
      await this.platform.setChamberLight(this.context.printerId, on);
      this.platform.log.debug('Set chamber light:', on);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.error(`Failed to set chamber light: ${message}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private getLightOn(): CharacteristicValue {
    const state = this.platform.getState(this.context.printerId);
    return state.online ? state.chamberLightOn : false;
  }

  private async setPrintActive(value: CharacteristicValue) {
    const active = value as boolean;

    try {
      await this.platform.setPrintingActive(this.context.printerId, active);
      this.platform.log.debug('Set print active:', active);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.error(`Failed to set print state: ${message}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private getPrintActive(): CharacteristicValue {
    const state = this.platform.getState(this.context.printerId);
    return state.online && state.printing && !state.paused;
  }

  private async setSpeedOn(value: CharacteristicValue) {
    const on = value as boolean;

    if (!on) {
      try {
        await this.platform.setSpeedPercent(this.context.printerId, 50);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.platform.log.error(`Failed to set default speed profile: ${message}`);
      }
    }
  }

  private getSpeedOn(): CharacteristicValue {
    return this.platform.getState(this.context.printerId).online;
  }

  private async setSpeedPercent(value: CharacteristicValue) {
    const percent = value as number;

    try {
      await this.platform.setSpeedPercent(this.context.printerId, percent);
      this.platform.log.debug('Set print speed percent:', percent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.error(`Failed to set print speed: ${message}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private getSpeedPercent(): CharacteristicValue {
    return this.platform.getState(this.context.printerId).speedPercent;
  }
}
